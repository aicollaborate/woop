import SwiftUI

@main
struct FlowixIOSApp: App {
    var body: some Scene {
        WindowGroup {
            if ProcessInfo.processInfo.arguments.contains("--editor-smoke") {
                EditorSmokeView()
            } else {
                RootView()
            }
        }
    }
}
