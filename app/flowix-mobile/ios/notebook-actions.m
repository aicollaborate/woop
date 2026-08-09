#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>

static NSMutableDictionary<NSString *, UIButton *> *flowix_notebook_action_buttons;
static UIViewController *flowix_top_view_controller(void);
static void flowix_emit_notebook_action(WKWebView *webView,
                                         NSString *notebookId,
                                         NSString *action);

static WKWebView *flowix_find_web_view(UIView *view) {
  if ([view isKindOfClass:[WKWebView class]]) return (WKWebView *)view;
  for (UIView *subview in view.subviews) {
    WKWebView *webView = flowix_find_web_view(subview);
    if (webView) return webView;
  }
  return nil;
}

// Keep the ellipsis controls as real UIKit buttons. UIButton.menu with
// showsMenuAsPrimaryAction gives us the anchored iOS pop-up menu used by
// system controls, instead of an UIAlertController alert/action sheet.
void flowix_sync_notebook_action_buttons(const char *json) {
  NSString *jsonString = json ? [NSString stringWithUTF8String:json] : @"[]";
  dispatch_async(dispatch_get_main_queue(), ^{
    NSData *data = [jsonString dataUsingEncoding:NSUTF8StringEncoding];
    NSArray *items = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![items isKindOfClass:[NSArray class]]) return;

    UIViewController *controller = flowix_top_view_controller();
    WKWebView *webView = controller ? flowix_find_web_view(controller.view) : nil;
    if (!controller || !webView) return;

    if (!flowix_notebook_action_buttons) {
      flowix_notebook_action_buttons = [NSMutableDictionary dictionary];
    }
    NSMutableDictionary<NSString *, UIButton *> *buttons = flowix_notebook_action_buttons;
    NSMutableSet *activeIds = [NSMutableSet set];
    CGRect webViewRect = [webView convertRect:webView.bounds toView:controller.view];

    for (NSDictionary *item in items) {
      if (![item isKindOfClass:[NSDictionary class]]) continue;
      NSString *notebookId = item[@"id"];
      NSString *notebookName = item[@"name"] ?: @"";
      if (![notebookId isKindOfClass:[NSString class]]) continue;
      [activeIds addObject:notebookId];

      UIButton *button = buttons[notebookId];
      if (!button) {
        button = [UIButton buttonWithType:UIButtonTypeSystem];
        UIImageSymbolConfiguration *symbolConfiguration =
            [UIImageSymbolConfiguration configurationWithPointSize:14.4
                                                              weight:UIImageSymbolWeightRegular];
        [button setImage:[UIImage systemImageNamed:@"ellipsis" withConfiguration:symbolConfiguration]
                forState:UIControlStateNormal];
        button.tintColor = [UIColor colorWithWhite:0.75 alpha:1.0];
        button.backgroundColor = UIColor.clearColor;
        __weak WKWebView *weakWebView = webView;
        __weak UIButton *weakButton = button;
        UIAction *edit = [UIAction actionWithTitle:@"编辑笔记本"
                                               image:[UIImage systemImageNamed:@"pencil"]
                                          identifier:nil
                                             handler:^(__unused UIAction *action) {
          weakButton.hidden = YES;
          flowix_emit_notebook_action(weakWebView, notebookId, @"edit");
        }];
        UIAction *delete = [UIAction actionWithTitle:@"删除"
                                                 image:[UIImage systemImageNamed:@"trash"]
                                            identifier:nil
                                               handler:^(__unused UIAction *action) {
          weakButton.hidden = YES;
          flowix_emit_notebook_action(weakWebView, notebookId, @"delete");
        }];
        delete.attributes = UIMenuElementAttributesDestructive;
        button.menu = [UIMenu menuWithTitle:@"" children:@[edit, delete]];
        button.showsMenuAsPrimaryAction = YES;
        buttons[notebookId] = button;
        [controller.view addSubview:button];
      }

      CGFloat x = [item[@"x"] doubleValue] + webViewRect.origin.x;
      CGFloat y = [item[@"y"] doubleValue] + webViewRect.origin.y;
      CGFloat width = MAX([item[@"width"] doubleValue], 44.0) * 0.8;
      CGFloat height = MAX([item[@"height"] doubleValue], 44.0) * 0.8;
      CGFloat originalWidth = MAX([item[@"width"] doubleValue], 44.0);
      CGFloat originalHeight = MAX([item[@"height"] doubleValue], 44.0);
      button.transform = CGAffineTransformIdentity;
      button.frame = CGRectMake(x + (originalWidth - width) / 2.0,
                                y + (originalHeight - height) / 2.0,
                                width,
                                height);
      button.hidden = NO;
      button.accessibilityLabel = [NSString stringWithFormat:@"更多%@操作", notebookName];
    }

    for (NSString *notebookId in [buttons.allKeys copy]) {
      if (![activeIds containsObject:notebookId]) {
        [buttons[notebookId] removeFromSuperview];
        [buttons removeObjectForKey:notebookId];
      }
    }
  });
}

// The drawer itself is translated inside the WebView. Apply the same
// translation to the native overlay while the finger is dragging, without
// recalculating every button's absolute frame on every move.
void flowix_set_notebook_action_buttons_offset(double offset) {
  dispatch_async(dispatch_get_main_queue(), ^{
    for (UIButton *button in flowix_notebook_action_buttons.allValues) {
      button.transform = CGAffineTransformMakeTranslation(offset, 0.0);
    }
  });
}

static UIViewController *flowix_top_view_controller(void) {
  UIWindow *window = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:[UIWindowScene class]]) continue;
    if (scene.activationState != UISceneActivationStateForegroundActive) continue;
    for (UIWindow *candidate in ((UIWindowScene *)scene).windows) {
      if (candidate.isKeyWindow) {
        window = candidate;
        break;
      }
    }
    if (window) break;
  }

  UIViewController *controller = window.rootViewController;
  while (controller.presentedViewController && !controller.presentedViewController.isBeingDismissed) {
    controller = controller.presentedViewController;
  }
  if ([controller isKindOfClass:[UINavigationController class]]) {
    controller = ((UINavigationController *)controller).visibleViewController;
  }
  if ([controller isKindOfClass:[UITabBarController class]]) {
    controller = ((UITabBarController *)controller).selectedViewController;
  }
  return controller;
}

static void flowix_emit_notebook_action(WKWebView *webView,
                                         NSString *notebookId,
                                         NSString *action) {
  if (!webView || !notebookId || !action) return;
  NSData *idData = [NSJSONSerialization dataWithJSONObject:@[notebookId] options:0 error:nil];
  NSData *actionData = [NSJSONSerialization dataWithJSONObject:@[action] options:0 error:nil];
  NSString *idJson = [[NSString alloc] initWithData:idData encoding:NSUTF8StringEncoding];
  NSString *actionJson = [[NSString alloc] initWithData:actionData encoding:NSUTF8StringEncoding];
  if (idJson.length < 2 || actionJson.length < 2) return;
  idJson = [idJson substringWithRange:NSMakeRange(1, idJson.length - 2)];
  actionJson = [actionJson substringWithRange:NSMakeRange(1, actionJson.length - 2)];
  NSString *script = [NSString stringWithFormat:
      @"window.dispatchEvent(new CustomEvent('flowix-native-notebook-action',{detail:{id:%@,action:%@}}));",
      idJson, actionJson];
  [webView evaluateJavaScript:script completionHandler:nil];
}

// Present a real iOS action sheet. The action is delivered as a DOM event,
// rather than through a Rust callback pointer, so closing/reloading the
// WebView cannot leave native UIKit holding a dangling allocation.
void flowix_show_notebook_actions(const char *notebook_id, const char *name) {
  NSString *notebookId = notebook_id ? [NSString stringWithUTF8String:notebook_id] : @"";
  NSString *notebookName = name ? [NSString stringWithUTF8String:name] : @"";
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *controller = flowix_top_view_controller();
    WKWebView *webView = controller ? flowix_find_web_view(controller.view) : nil;
    if (!controller || !webView || notebookId.length == 0) return;

    UIAlertController *alert =
        [UIAlertController alertControllerWithTitle:@"笔记本操作"
                                            message:notebookName
                                     preferredStyle:UIAlertControllerStyleActionSheet];
    [alert addAction:[UIAlertAction actionWithTitle:@"编辑笔记本"
                                              style:UIAlertActionStyleDefault
                                            handler:^(__unused UIAlertAction *action) {
      flowix_emit_notebook_action(webView, notebookId, @"edit");
    }]];
    [alert addAction:[UIAlertAction actionWithTitle:@"删除"
                                              style:UIAlertActionStyleDestructive
                                            handler:^(__unused UIAlertAction *action) {
      flowix_emit_notebook_action(webView, notebookId, @"delete");
    }]];
    [alert addAction:[UIAlertAction actionWithTitle:@"取消"
                                              style:UIAlertActionStyleCancel
                                            handler:nil]];

    if (alert.popoverPresentationController) {
      alert.popoverPresentationController.sourceView = controller.view;
      alert.popoverPresentationController.sourceRect =
          CGRectMake(CGRectGetMidX(controller.view.bounds),
                     CGRectGetMaxY(controller.view.bounds) - 1,
                     1,
                     1);
      alert.popoverPresentationController.permittedArrowDirections = 0;
    }
    [controller presentViewController:alert animated:YES completion:nil];
  });
}
