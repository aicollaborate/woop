use flowix_sync::{AppleAuthChallenge, AppleAuthorization};
use tauri::WebviewWindow;

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::{Cell, RefCell};

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{
        define_class, msg_send, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly,
    };
    use objc2_authentication_services::{
        ASAuthorization, ASAuthorizationAppleIDCredential, ASAuthorizationAppleIDProvider,
        ASAuthorizationController, ASAuthorizationControllerDelegate,
        ASAuthorizationControllerPresentationContextProviding, ASAuthorizationRequest,
        ASAuthorizationScopeEmail, ASAuthorizationScopeFullName, ASPresentationAnchor,
    };
    use objc2_foundation::{NSArray, NSError, NSString};
    use tauri::WebviewWindow;
    use tokio::sync::oneshot;

    use flowix_sync::{AppleAuthChallenge, AppleAuthorization};

    struct NativeCredential {
        identity_token: String,
        authorization_code: String,
        display_name: Option<String>,
    }

    struct AppleAuthorizationIvars {
        sender: RefCell<Option<oneshot::Sender<Result<NativeCredential, String>>>>,
        presentation_anchor: Retained<ASPresentationAnchor>,
        finished: Cell<bool>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = AppleAuthorizationIvars]
        struct AppleAuthorizationDelegate;

        unsafe impl NSObjectProtocol for AppleAuthorizationDelegate {}

        #[allow(non_snake_case)]
        unsafe impl ASAuthorizationControllerPresentationContextProviding for AppleAuthorizationDelegate {
            #[unsafe(method_id(presentationAnchorForAuthorizationController:))]
            unsafe fn presentationAnchorForAuthorizationController(
                &self,
                _controller: &ASAuthorizationController,
            ) -> Retained<ASPresentationAnchor> {
                self.ivars().presentation_anchor.clone()
            }
        }

        #[allow(non_snake_case)]
        unsafe impl ASAuthorizationControllerDelegate for AppleAuthorizationDelegate {
            #[unsafe(method(authorizationController:didCompleteWithAuthorization:))]
            unsafe fn authorizationController_didCompleteWithAuthorization(
                &self,
                _controller: &ASAuthorizationController,
                authorization: &ASAuthorization,
            ) {
                let credential = authorization.credential();
                let object: &AnyObject = credential.as_ref();
                let Some(apple) = object.downcast_ref::<ASAuthorizationAppleIDCredential>() else {
                    self.finish(Err("APPLE_CREDENTIAL_TYPE_INVALID".to_string()));
                    return;
                };
                let result = (|| {
                    let identity_token = apple
                        .identityToken()
                        .ok_or_else(|| "APPLE_IDENTITY_TOKEN_MISSING".to_string())?;
                    let authorization_code = apple
                        .authorizationCode()
                        .ok_or_else(|| "APPLE_AUTHORIZATION_CODE_MISSING".to_string())?;
                    let identity_token = String::from_utf8(identity_token.to_vec())
                        .map_err(|_| "APPLE_IDENTITY_TOKEN_INVALID".to_string())?;
                    let authorization_code = String::from_utf8(authorization_code.to_vec())
                        .map_err(|_| "APPLE_AUTHORIZATION_CODE_INVALID".to_string())?;
                    let display_name = apple.fullName().and_then(|name| {
                        let parts = [name.givenName(), name.familyName()]
                            .into_iter()
                            .flatten()
                            .map(|part| part.to_string())
                            .filter(|part| !part.trim().is_empty())
                            .collect::<Vec<_>>();
                        (!parts.is_empty()).then(|| parts.join(" "))
                    });
                    Ok(NativeCredential {
                        identity_token,
                        authorization_code,
                        display_name,
                    })
                })();
                self.finish(result);
            }

            #[unsafe(method(authorizationController:didCompleteWithError:))]
            unsafe fn authorizationController_didCompleteWithError(
                &self,
                _controller: &ASAuthorizationController,
                error: &NSError,
            ) {
                self.finish(Err(format!(
                    "APPLE_AUTHORIZATION_FAILED: {}",
                    error.localizedDescription()
                )));
            }
        }
    );

    impl AppleAuthorizationDelegate {
        fn new(
            mtm: MainThreadMarker,
            presentation_anchor: Retained<ASPresentationAnchor>,
            sender: oneshot::Sender<Result<NativeCredential, String>>,
        ) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(AppleAuthorizationIvars {
                sender: RefCell::new(Some(sender)),
                presentation_anchor,
                finished: Cell::new(false),
            });
            unsafe { msg_send![super(this), init] }
        }

        fn finish(&self, result: Result<NativeCredential, String>) {
            self.ivars().finished.set(true);
            if let Some(sender) = self.ivars().sender.borrow_mut().take() {
                let _ = sender.send(result);
            }
        }
    }

    thread_local! {
        static ACTIVE_DELEGATE: RefCell<Option<Retained<AppleAuthorizationDelegate>>> = const { RefCell::new(None) };
    }

    fn start_authorization(
        window_address: usize,
        nonce: String,
        sender: oneshot::Sender<Result<NativeCredential, String>>,
    ) -> Result<(), String> {
        let mtm =
            MainThreadMarker::new().ok_or_else(|| "APPLE_AUTH_NOT_ON_MAIN_THREAD".to_string())?;
        let busy = ACTIVE_DELEGATE.with(|slot| {
            slot.borrow()
                .as_ref()
                .is_some_and(|delegate| !delegate.ivars().finished.get())
        });
        if busy {
            return Err("APPLE_AUTHORIZATION_IN_PROGRESS".to_string());
        }
        let presentation_anchor = unsafe {
            Retained::<ASPresentationAnchor>::retain(window_address as *mut ASPresentationAnchor)
        }
        .ok_or_else(|| "APPLE_PRESENTATION_WINDOW_MISSING".to_string())?;
        let delegate = AppleAuthorizationDelegate::new(mtm, presentation_anchor, sender);
        let provider = unsafe { ASAuthorizationAppleIDProvider::new() };
        let request = unsafe { provider.createRequest() };
        let nonce = NSString::from_str(&nonce);
        let scopes = NSArray::from_slice(unsafe {
            &[ASAuthorizationScopeFullName, ASAuthorizationScopeEmail]
        });
        unsafe {
            request.setNonce(Some(&nonce));
            request.setRequestedScopes(Some(&scopes));
        }
        let request: &ASAuthorizationRequest = &request;
        let requests = NSArray::from_slice(&[request]);
        let controller = unsafe {
            ASAuthorizationController::initWithAuthorizationRequests(
                ASAuthorizationController::alloc(),
                &requests,
            )
        };
        unsafe {
            controller.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            controller.setPresentationContextProvider(Some(ProtocolObject::from_ref(&*delegate)));
            controller.performRequests();
        }
        ACTIVE_DELEGATE.with(|slot| {
            slot.replace(Some(delegate));
        });
        Ok(())
    }

    pub async fn authorize(
        window: WebviewWindow,
        challenge: AppleAuthChallenge,
    ) -> Result<AppleAuthorization, String> {
        let window_address = window.ns_window().map_err(|error| error.to_string())? as usize;
        let (sender, receiver) = oneshot::channel();
        let nonce = challenge.nonce.clone();
        window
            .run_on_main_thread(move || {
                if let Err(error) = start_authorization(window_address, nonce, sender) {
                    // The sender has moved into start_authorization. A setup error
                    // is surfaced by dropping it, and converted below.
                    tracing::error!("failed to start Apple authorization: {error}");
                }
            })
            .map_err(|error| error.to_string())?;
        let credential = receiver
            .await
            .map_err(|_| "APPLE_AUTHORIZATION_START_FAILED".to_string())??;
        Ok(AppleAuthorization {
            challenge_id: challenge.challenge_id,
            nonce: challenge.nonce,
            identity_token: credential.identity_token,
            authorization_code: credential.authorization_code,
            display_name: credential.display_name,
        })
    }
}

#[cfg(target_os = "macos")]
pub async fn authorize(
    window: WebviewWindow,
    challenge: AppleAuthChallenge,
) -> Result<AppleAuthorization, String> {
    platform::authorize(window, challenge).await
}

#[cfg(not(target_os = "macos"))]
pub async fn authorize(
    _window: WebviewWindow,
    _challenge: AppleAuthChallenge,
) -> Result<AppleAuthorization, String> {
    Err("APPLE_SIGN_IN_REQUIRES_MACOS".to_string())
}
