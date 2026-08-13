import SwiftUI
import WebKit

/// Renders the same SVG notebook icon assets used by the Web mobile drawer.
/// WKWebView is used here because UIKit/SwiftUI do not decode SVG files by
/// themselves, while keeping the source SVGs as the single visual source.
struct NativeNotebookIcon: UIViewRepresentable {
    let icon: String
    let name: String
    let isSelected: Bool

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.isUserInteractionEnabled = false
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        load(icon: icon, name: name, isSelected: isSelected, in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        load(icon: icon, name: name, isSelected: isSelected, in: webView)
    }

    private func load(icon: String, name: String, isSelected: Bool, in webView: WKWebView) {
        let tint = isSelected ? "#D1785B" : "#E5E1D8"
        let fallback = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased()
        let markup: String

        if let directory = Bundle.main.url(forResource: "notebook-icons", withExtension: nil),
           !icon.isEmpty {
            let svgURL = directory.appendingPathComponent(icon).appendingPathExtension("svg")
            if let svg = try? String(contentsOf: svgURL, encoding: .utf8) {
                markup = svg
                    .replacingOccurrences(of: "fill='#09244BFF'", with: "fill='currentColor'")
                    .replacingOccurrences(of: "fill=\"#09244BFF\"", with: "fill=\"currentColor\"")
            } else {
                markup = "<span class=\"fallback\">\(fallback.isEmpty ? "N" : fallback)</span>"
            }
        } else {
            markup = "<span class=\"fallback\">\(fallback.isEmpty ? "N" : fallback)</span>"
        }

        let html = """
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
          <style>
            html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
            body { display: flex; align-items: center; justify-content: center; color: \(tint); }
            svg { display: block; width: 78%; height: 78%; opacity: .9; }
            .fallback { font: 500 14px -apple-system, BlinkMacSystemFont, sans-serif; }
          </style>
        </head>
        <body>\(markup)</body>
        </html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }
}
