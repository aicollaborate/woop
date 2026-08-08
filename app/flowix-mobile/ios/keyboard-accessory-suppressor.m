#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>

// Flowix provides its own formatting toolbar above the keyboard. Remove the
// system input assistant groups from WKWebView so iOS does not show a second
// accessory bar above it.
@interface FlowixKeyboardAccessorySuppressor : NSObject
@end

@implementation FlowixKeyboardAccessorySuppressor

+ (void)load {
  [[NSNotificationCenter defaultCenter]
      addObserver:self
         selector:@selector(applicationDidBecomeActive:)
             name:UIApplicationDidBecomeActiveNotification
           object:nil];
}

+ (void)applicationDidBecomeActive:(NSNotification *)notification {
  (void)notification;
  // Tauri may attach WKWebView just after the application active callback.
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.25 * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
    [self suppressInApplication];
  });
}

+ (void)suppressInApplication {
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:[UIWindowScene class]]) continue;
    for (UIWindow *window in ((UIWindowScene *)scene).windows) {
      [self suppressInView:window];
    }
  }
}

+ (void)suppressInView:(UIView *)view {
  if ([view isKindOfClass:[WKWebView class]]) {
    WKWebView *webView = (WKWebView *)view;
    webView.inputAssistantItem.leadingBarButtonGroups = @[];
    webView.inputAssistantItem.trailingBarButtonGroups = @[];
  }

  // The actual first responder is an internal WKContentView on some iOS
  // versions, so clear the accessory groups on the whole WebKit subtree too.
  if ([view respondsToSelector:@selector(inputAssistantItem)]) {
    view.inputAssistantItem.leadingBarButtonGroups = @[];
    view.inputAssistantItem.trailingBarButtonGroups = @[];
  }

  for (UIView *subview in view.subviews) {
    [self suppressInView:subview];
  }
}

@end
