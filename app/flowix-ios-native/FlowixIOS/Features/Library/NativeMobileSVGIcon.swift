import SwiftUI
import WebKit

/// The mobile WebView's navigation, list-action, and new-note icons rendered as SVG.
///
/// Keeping the SVG markup here makes the native list use the same viewBox,
/// stroke width, caps, joins, and paths as the mobile WebView. WKWebView is
/// already used by the native target for the shared notebook and cloud SVGs.
enum NativeMobileSVGIcon {
    case menu
    case search
    case squarePen
    case pushPinRegular
    case pushPinFill
    case trashSimpleRegular

    var markup: String {
        switch self {
        case .menu:
            return """
            <path d="M4 6h15" />
            <path d="M4 12h11" />
            <path d="M4 18h16" />
            """
        case .search:
            return """
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
            """
        case .squarePen:
            // Exact paths from lucide-react's SquarePen used by mobile-app.tsx.
            return """
            <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
            """
        case .pushPinRegular:
            return """
            <path d="M235.32,81.37,174.63,20.69a16,16,0,0,0-22.63,0L98.37,74.49c-10.66-3.34-35-7.37-60.4,13.14a16,16,0,0,0-1.29,23.78L85,159.71,42.34,202.34a8,8,0,0,0,11.32,11.32L96.29,171l48.29,48.29A16,16,0,0,0,155.9,224c.38,0,.75,0,1.13,0a15.93,15.93,0,0,0,11.64-6.33c19.64-26.1,17.75-47.32,13.19-60L235.33,104A16,16,0,0,0,235.32,81.37ZM224,92.69h0l-57.27,57.46a8,8,0,0,0-1.49,9.22c9.46,18.93-1.8,38.59-9.34,48.62L48,100.08c12.08-9.74,23.64-12.31,32.48-12.31A40.13,40.13,0,0,1,96.81,91a8,8,0,0,0,9.25-1.51L163.32,32,224,92.68Z" />
            """
        case .pushPinFill:
            return """
            <path d="M235.33,104l-53.47,53.65c4.56,12.67,6.45,33.89-13.19,60A15.93,15.93,0,0,1,157,224c-.38,0-.75,0-1.13,0a16,16,0,0,1-11.32-4.69L96.29,171,53.66,213.66a8,8,0,0,1-11.32-11.32L85,159.71l-48.3-48.3A16,16,0,0,1,38,87.63c25.42-20.51,49.75-16.48,60.4-13.14L152,20.7a16,16,0,0,1,22.63,0l60.69,60.68A16,16,0,0,1,235.33,104Z" />
            """
        case .trashSimpleRegular:
            return """
            <path d="M216,48H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM192,208H64V64H192ZM80,24a8,8,0,0,1,8-8h80a8,8,0,0,1,0,16H88A8,8,0,0,1,80,24Z" />
            """
        }
    }

    var strokeWidth: String {
        switch self {
        case .menu, .search, .squarePen:
            return "1.8"
        case .pushPinRegular, .pushPinFill, .trashSimpleRegular:
            return "0"
        }
    }

    var size: Int {
        switch self {
        case .menu, .search:
            return 21
        case .squarePen:
            return 24
        case .pushPinRegular, .pushPinFill, .trashSimpleRegular:
            return 256
        }
    }

    var viewBox: String {
        switch self {
        case .menu, .search, .squarePen:
            return "0 0 24 24"
        case .pushPinRegular, .pushPinFill, .trashSimpleRegular:
            return "0 0 256 256"
        }
    }

    var fill: String {
        switch self {
        case .menu, .search, .squarePen:
            return "none"
        case .pushPinRegular, .pushPinFill, .trashSimpleRegular:
            return "currentColor"
        }
    }

    var stroke: String {
        switch self {
        case .menu, .search, .squarePen:
            return "currentColor"
        case .pushPinRegular, .pushPinFill, .trashSimpleRegular:
            return "none"
        }
    }
}

struct NativeMobileSVGIconView: UIViewRepresentable {
    let icon: NativeMobileSVGIcon
    let color: String

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.isUserInteractionEnabled = false
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        load(in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        load(in: webView)
    }

    private func load(in webView: WKWebView) {
        let html = """
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
          <style>
            html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
            body { display: flex; align-items: center; justify-content: center; color: \(color); }
            svg { display: block; width: 100%; height: 100%; overflow: visible; }
          </style>
        </head>
        <body>
          <svg xmlns="http://www.w3.org/2000/svg" width="\(icon.size)" height="\(icon.size)" viewBox="\(icon.viewBox)" fill="\(icon.fill)" stroke="\(icon.stroke)" stroke-width="\(icon.strokeWidth)" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            \(icon.markup)
          </svg>
        </body>
        </html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }
}
