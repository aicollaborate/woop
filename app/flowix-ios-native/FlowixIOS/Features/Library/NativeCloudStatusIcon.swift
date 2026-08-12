import SwiftUI
import WebKit

enum NativeCloudStatus: String {
    case unlinked
    case connected
    case connecting
}

/// The native list uses the same Cloud family mark as the mobile WebView.
/// The SVG stays inline so the three states keep identical bounds and paths.
struct NativeCloudStatusIcon: UIViewRepresentable {
    let status: NativeCloudStatus
    let color: String

    init(status: NativeCloudStatus, color: String = "#1F2937") {
        self.status = status
        self.color = color
    }

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.isUserInteractionEnabled = false
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        load(status: status, in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        load(status: status, in: webView)
    }

    private func load(status: NativeCloudStatus, in webView: WKWebView) {
        let markup: String
        switch status {
        case .unlinked:
            markup = """
            <path d="\(Self.cloudFramePath)" />
            <path d="\(Self.cloudFrameClosurePath)" />
            <path d="M48,40L208,216" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="16" />
            """
        case .connected:
            markup = """
            <path d="\(Self.cloudFramePath)" />
            <path d="\(Self.cloudFrameClosurePath)" />
            <path d="\(Self.cloudCheckPath)" />
            """
        case .connecting:
            markup = """
            <path d="\(Self.cloudFramePath)" />
            <path class="sync-arrow sync-arrow-down" d="\(Self.cloudArrowDownPath)" />
            <path class="sync-arrow sync-arrow-up" d="\(Self.cloudArrowUpPath)" />
            """
        }

        let opacity = status == .connecting ? ".67" : "1"
        let html = """
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
          <style>
            html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
            body { display: flex; align-items: center; justify-content: center; color: \(color); opacity: \(opacity); }
            svg { display: block; width: 100%; height: 100%; overflow: visible; }
            .sync-arrow { transform-origin: 50% 50%; }
            .sync-arrow-down { animation: cloud-sync-arrow-down 2.1s ease-in-out infinite; }
            .sync-arrow-up { animation: cloud-sync-arrow-up 2.1s ease-in-out infinite; }
            @keyframes cloud-sync-arrow-down {
              0%, 45% { opacity: 1; transform: translateY(1px); }
              55%, 100% { opacity: 0; transform: translateY(2px); }
            }
            @keyframes cloud-sync-arrow-up {
              0%, 45% { opacity: 0; transform: translateY(1px); }
              55%, 100% { opacity: 1; transform: translateY(-1px); }
            }
            @media (prefers-reduced-motion: reduce) {
              .sync-arrow { animation: none; opacity: 0; transform: none; }
              .sync-arrow-down { opacity: 1; }
            }
          </style>
        </head>
        <body>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
            \(markup)
          </svg>
        </body>
        </html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // Paths copied from shared/icons/cloud-status-icon.tsx.
    private static let cloudFramePath =
        "M248,128a87.34,87.34,0,0,1-17.6,52.81,8,8,0,1,1-12.8-9.62A71.34,71.34,0,0,0,232,128a72,72,0,0,0-144,0,8,8,0,0,1-16,0,88,88,0,0,1,3.29-23.88C74.2,104,73.1,104,72,104a48,48,0,0,0,0,96H96a8,8,0,0,1,0,16H72A64,64,0,1,1,81.29,88.68,87.34,87.34,0,0,1,248,128Z"
    private static let cloudArrowDownPath =
        "M178.34,170.34L160,188.69V128a8,8,0,0,0-16,0v60.69l-18.34-18.35a8,8,0,0,0-11.32,11.32l32,32a8,8,0,0,0,11.32,0l32-32a8,8,0,0,0-11.32-11.32Z"
    private static let cloudArrowUpPath =
        "M178.34,165.66L160,147.31V208a8,8,0,0,1-16,0v-60.69l-18.34,18.35a8,8,0,0,1-11.32-11.32l32-32a8,8,0,0,1,11.32,0l32,32a8,8,0,0,1-11.32,11.32Z"
    private static let cloudCheckPath =
        "M197.66,106.34a8,8,0,0,1,0,11.32l-48,48a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L144,148.69l42.34-42.35A8,8,0,0,1,197.66,106.34Z"
    private static let cloudFrameClosurePath =
        "M96,200H160a8,8,0,0,1,0,16H96a8,8,0,0,1,0-16Z"
}
