import Foundation
import UniformTypeIdentifiers
import WebKit

/// Serves only attachments belonging to the native Flowix data directory.
/// The web editor receives a URL, never a file URL, so it cannot request an
/// arbitrary path from the app container through WKWebView.
final class FlowixAssetSchemeHandler: NSObject, WKURLSchemeHandler {
    private let dataDirectory: URL
    private let fileManager = FileManager.default

    init(dataDirectory: URL) {
        self.dataDirectory = dataDirectory.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let requestURL = urlSchemeTask.request.url,
              requestURL.scheme == "flowix-asset",
              let fileURL = fileURL(from: requestURL),
              isAllowedAttachment(fileURL),
              fileManager.isReadableFile(atPath: fileURL.path),
              let data = try? Data(contentsOf: fileURL) else {
            urlSchemeTask.didFailWithError(NSError(
                domain: "FlowixAssetScheme",
                code: 404,
                userInfo: [NSLocalizedDescriptionKey: "附件不存在或无权访问。"]
            ))
            return
        }

        let mimeType = UTType(filenameExtension: fileURL.pathExtension)?.preferredMIMEType
            ?? "application/octet-stream"
        let response = URLResponse(
            url: requestURL,
            mimeType: mimeType,
            expectedContentLength: data.count,
            textEncodingName: nil
        )
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func fileURL(from url: URL) -> URL? {
        let prefix = "flowix-asset://localhost/"
        guard let encodedPath = url.absoluteString.removingPercentEncoding,
              encodedPath.hasPrefix(prefix) else { return nil }
        let path = String(encodedPath.dropFirst(prefix.count))
        guard path.hasPrefix("/") else { return nil }
        return URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
    }

    private func isAllowedAttachment(_ fileURL: URL) -> Bool {
        let attachmentsRoot = dataDirectory
            .appendingPathComponent("notebooks", isDirectory: true)
            .resolvingSymlinksInPath()
        let path = fileURL.path
        let root = attachmentsRoot.path.hasSuffix("/") ? attachmentsRoot.path : attachmentsRoot.path + "/"
        guard path.hasPrefix(root) else { return false }
        let components = fileURL.pathComponents
        guard let attachmentsIndex = components.lastIndex(of: "attachments"),
              attachmentsIndex > 0,
              attachmentsIndex + 1 < components.count else { return false }
        return components[attachmentsIndex - 1] != ".."
    }
}
