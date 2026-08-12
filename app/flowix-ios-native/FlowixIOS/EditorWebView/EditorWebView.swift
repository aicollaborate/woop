import SwiftUI
import UIKit
import WebKit

struct EditorWebView: UIViewRepresentable {
    let memoId: String
    let content: String
    let onContentChanged: (String) -> Void
    let onReady: () -> Void
    let onError: (String) -> Void
    let runBridgeSmokeTest: Bool

    init(
        memoId: String,
        content: String,
        onContentChanged: @escaping (String) -> Void,
        onReady: @escaping () -> Void = {},
        onError: @escaping (String) -> Void = { message in print("[Flowix EditorWebView] \(message)") },
        runBridgeSmokeTest: Bool = false
    ) {
        self.memoId = memoId
        self.content = content
        self.onContentChanged = onContentChanged
        self.onReady = onReady
        self.onError = onError
        self.runBridgeSmokeTest = runBridgeSmokeTest
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> NativeEditorHostView {
        let configuration = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "flowixEditor")
        configuration.userContentController = controller

        if let dataDirectory = try? FlowixAPI.applicationDataDirectoryURL() {
            configuration.setURLSchemeHandler(
                FlowixAssetSchemeHandler(dataDirectory: dataDirectory),
                forURLScheme: "flowix-asset"
            )
        }

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.configuration.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        // The document editor is a white paper surface. Keeping the native
        // WebView transparent lets the SwiftUI presenting page show through
        // wherever the HTML viewport has not painted yet, which appears as a
        // separate block around the bottom safe area.
        webView.backgroundColor = .white
        webView.isOpaque = true
        webView.scrollView.backgroundColor = .white
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.underPageBackgroundColor = .white
        webView.scrollView.keyboardDismissMode = .interactive
        let coordinator = context.coordinator
        let host = NativeEditorHostView { [weak coordinator] action in
            coordinator?.sendToolbarAction(action)
        }
        host.install(webView: webView)
        context.coordinator.webView = webView
        context.coordinator.editorHost = host
        context.coordinator.startMotionDiagnostics(in: host)
        context.coordinator.loadEditor(in: webView)
        return host
    }

    func updateUIView(_ host: NativeEditorHostView, context: Context) {
        let coordinator = context.coordinator
        let contentChanged = coordinator.parent.content != self.content
        let memoChanged = coordinator.parent.memoId != self.memoId
        coordinator.parent = self

        // The native page loads the full memo asynchronously after the
        // WebView has already been created. Push that value into Tiptap, but
        // avoid pushing every SwiftUI update back into the editor: updates
        // caused by the editor itself must keep the caret and selection.
        if (contentChanged || memoChanged)
            && coordinator.isEditorReady
            && coordinator.lastSentContent != self.content {
            coordinator.sendContent()
        }
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: EditorWebView
        weak var webView: WKWebView?
        weak var editorHost: NativeEditorHostView?
        var isEditorReady = false
        var lastSentContent: String?
        var smokeChangeSent = false
        private var keyboardObservers: [NSObjectProtocol] = []

        init(parent: EditorWebView) {
            self.parent = parent
        }

        func loadEditor(in webView: WKWebView) {
            guard let directory = Bundle.main.url(forResource: "EditorWebView", withExtension: nil) else {
                webView.loadHTMLString("<p>编辑器资源未找到</p>", baseURL: nil)
                return
            }
            webView.loadFileURL(directory.appendingPathComponent("editor-webview.html"), allowingReadAccessTo: directory)
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == "flowixEditor",
                  let payload = message.body as? [String: Any],
                  let type = payload["type"] as? String else { return }

            switch type {
            case "diagnostic":
                if let message = payload["message"] as? String {
                    print("[Flowix EditorWebView] \(message)")
                }
            case "error":
                let message = payload["message"] as? String ?? "WebView 编辑器发生未知错误。"
                print("[Flowix EditorWebView] \(message)")
                parent.onError(message)
            case "ready":
                isEditorReady = true
                parent.onReady()
                sendContent()
                sendMotionDiagnosticsConfiguration()
                if parent.runBridgeSmokeTest && !smokeChangeSent {
                    smokeChangeSent = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                        self.sendCommand(
                            type: "applyContent",
                            content: self.parent.content + "\n\nnative-editor-bridge-smoke",
                            emitUpdate: true
                        )
                    }
                }
            case "changed":
                if let markdown = payload["markdown"] as? String {
                    lastSentContent = markdown
                    parent.onContentChanged(markdown)
                }
            case "formatState":
                if let state = payload["state"] as? [String: Any] {
                    editorHost?.apply(NativeEditorFormatState(payload: state))
                }
            case "motion":
                if let motion = payload["motion"] as? [String: Any] {
                    NativeMotionDiagnostics.shared.recordWeb(motion)
                }
            case "attachmentBegin":
                handleAttachmentBegin(payload)
            case "attachmentChunk":
                handleAttachmentChunk(payload)
            case "attachmentFinish":
                handleAttachmentFinish(payload)
            case "attachmentCancel":
                handleAttachmentCancel(payload)
            default:
                break
            }
        }

        private func handleAttachmentBegin(_ payload: [String: Any]) {
            guard let requestID = payload["requestId"] as? String,
                  let fileName = payload["fileName"] as? String,
                  let mimeType = payload["mimeType"] as? String,
                  let sizeBytes = payload["sizeBytes"] as? NSNumber,
                  let memoID = payload["memoId"] as? String else {
                return
            }
            Task {
                do {
                    let uploadID = try await FlowixAPI.shared.beginAttachmentUploadAsync(
                        fileName: fileName,
                        mimeType: mimeType,
                        sizeBytes: sizeBytes.uint64Value,
                        memoID: memoID
                    )
                    sendResponse(requestID: requestID, result: ["uploadId": uploadID])
                } catch {
                    sendResponse(requestID: requestID, error: error.localizedDescription)
                }
            }
        }

        private func handleAttachmentChunk(_ payload: [String: Any]) {
            guard let requestID = payload["requestId"] as? String,
                  let uploadID = payload["uploadId"] as? String,
                  let content = payload["content"] as? String else { return }
            Task {
                do {
                    try await FlowixAPI.shared.writeAttachmentChunkAsync(uploadID: uploadID, content: content)
                    sendResponse(requestID: requestID, result: [:])
                } catch {
                    sendResponse(requestID: requestID, error: error.localizedDescription)
                }
            }
        }

        private func handleAttachmentFinish(_ payload: [String: Any]) {
            guard let requestID = payload["requestId"] as? String,
                  let uploadID = payload["uploadId"] as? String else { return }
            Task {
                do {
                    let storageKey = try await FlowixAPI.shared.finishAttachmentUploadAsync(uploadID: uploadID)
                    sendResponse(requestID: requestID, result: ["storageKey": storageKey])
                } catch {
                    sendResponse(requestID: requestID, error: error.localizedDescription)
                }
            }
        }

        private func handleAttachmentCancel(_ payload: [String: Any]) {
            guard let requestID = payload["requestId"] as? String,
                  let uploadID = payload["uploadId"] as? String else { return }
            Task {
                do {
                    try await FlowixAPI.shared.cancelAttachmentUploadAsync(uploadID: uploadID)
                    sendResponse(requestID: requestID, result: [:])
                } catch {
                    sendResponse(requestID: requestID, error: error.localizedDescription)
                }
            }
        }

        private func sendResponse(requestID: String, result: [String: Any] = [:], error: String? = nil) {
            var payload: [String: Any] = ["requestId": requestID, "ok": error == nil]
            if let error { payload["error"] = error }
            if !result.isEmpty { payload["result"] = result }
            guard let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { [weak self] in
                self?.webView?.evaluateJavaScript(
                    "window.dispatchEvent(new CustomEvent('flowix-editor-response',{detail:\(json)}));"
                )
            }
        }

        func startMotionDiagnostics(in host: NativeEditorHostView) {
            guard NativeMotionDiagnostics.isEnabled else { return }
            let center = NotificationCenter.default
            let names: [NSNotification.Name] = [
                UIResponder.keyboardWillShowNotification,
                UIResponder.keyboardWillHideNotification,
                UIResponder.keyboardWillChangeFrameNotification,
                UIResponder.keyboardDidChangeFrameNotification,
            ]
            keyboardObservers = names.map { name in
                center.addObserver(forName: name, object: nil, queue: .main) { [weak host] notification in
                    guard let host else { return }
                    let frame = (notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect) ?? .zero
                    NativeMotionDiagnostics.shared.record(
                        "keyboard.\(name.rawValue.components(separatedBy: ".").last ?? "event")",
                        "end=\(NativeMotionDiagnostics.rect(frame)) host=\(NativeMotionDiagnostics.rect(host.convert(host.bounds, to: nil)))"
                    )
                }
            }
        }

    func webView(
        _ webView: WKWebView,
        didFinish navigation: WKNavigation!
    ) {
        webView.evaluateJavaScript(
            "JSON.stringify({webkit:typeof window.webkit,handler:typeof window.webkit?.messageHandlers?.flowixEditor})"
        ) { result, error in
            print("[Flowix EditorWebView] bridge=\(result ?? "nil") error=\(error?.localizedDescription ?? "none")")
        }
        sendContent()
    }

        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation!,
            withError error: Error
        ) {
            parent.onError("WebView 加载失败：\(error.localizedDescription)")
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            parent.onError("WebView 资源加载失败：\(error.localizedDescription)")
        }

        func sendContent() {
            sendCommand(type: "setContent", content: parent.content, emitUpdate: false)
            lastSentContent = parent.content
        }

        private func sendMotionDiagnosticsConfiguration() {
            guard let webView,
                  let data = try? JSONSerialization.data(withJSONObject: [
                    "type": "setMotionDiagnostics",
                    "enabled": NativeMotionDiagnostics.isEnabled,
                  ]),
                  let commandJSON = String(data: data, encoding: .utf8) else { return }
            webView.evaluateJavaScript(
                "window.dispatchEvent(new CustomEvent('flowix-editor-command',{detail:\(commandJSON)}));"
            )
        }

        deinit {
            keyboardObservers.forEach(NotificationCenter.default.removeObserver)
        }

        func sendToolbarAction(_ action: NativeEditorToolbarAction) {
            guard let webView,
                  let data = try? JSONSerialization.data(withJSONObject: [
                    "type": "toolbarAction",
                    "action": action.rawValue,
                  ]),
                  let commandJSON = String(data: data, encoding: .utf8) else { return }
            let script = "window.dispatchEvent(new CustomEvent('flowix-editor-command',{detail:\(commandJSON)}));"
            webView.evaluateJavaScript(script)
        }

        func sendCommand(type: String, content: String, emitUpdate: Bool) {
            guard let webView,
                  let data = try? JSONSerialization.data(withJSONObject: [
                    "type": type,
                    "memoId": parent.memoId,
                    "content": content,
                    "emitUpdate": emitUpdate,
                  ]),
                  let commandJSON = String(data: data, encoding: .utf8) else { return }
            let script = "window.dispatchEvent(new CustomEvent('flowix-editor-command',{detail:\(commandJSON)}));"
            webView.evaluateJavaScript(script)
        }
    }
}

/// Format state is owned by Tiptap; Swift only renders it and forwards taps.
struct NativeEditorFormatState {
    let focused: Bool
    let bold: Bool
    let italic: Bool
    let heading: Int?
    let bulletList: Bool
    let orderedList: Bool
    let taskList: Bool
    let blockquote: Bool
    let codeBlock: Bool

    init(payload: [String: Any]) {
        focused = payload["focused"] as? Bool ?? false
        bold = payload["bold"] as? Bool ?? false
        italic = payload["italic"] as? Bool ?? false
        heading = (payload["heading"] as? NSNumber)?.intValue
        bulletList = payload["bulletList"] as? Bool ?? false
        orderedList = payload["orderedList"] as? Bool ?? false
        taskList = payload["taskList"] as? Bool ?? false
        blockquote = payload["blockquote"] as? Bool ?? false
        codeBlock = payload["codeBlock"] as? Bool ?? false
    }
}

enum NativeEditorToolbarAction: String, CaseIterable {
    case bold, italic, heading1, heading2, bulletList, orderedList, taskList
    case blockquote, codeBlock, attachment, dismiss
}

/// A public-API replacement for WKWebView's private input accessory view.
/// The keyboard layout guide tracks software keyboards, undocked keyboards,
/// rotation, and split view without depending on WebKit implementation details.
final class NativeEditorHostView: UIView {
    private let toolbar: NativeEditorToolbar
    private(set) var webView: WKWebView?

    init(onToolbarAction: @escaping (NativeEditorToolbarAction) -> Void) {
        toolbar = NativeEditorToolbar(onAction: onToolbarAction)
        super.init(frame: .zero)
        backgroundColor = .white
        toolbar.translatesAutoresizingMaskIntoConstraints = false
        addSubview(toolbar)
        NSLayoutConstraint.activate([
            toolbar.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            toolbar.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            toolbar.heightAnchor.constraint(equalToConstant: 60),
            toolbar.bottomAnchor.constraint(equalTo: keyboardLayoutGuide.topAnchor, constant: -4),
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func install(webView: WKWebView) {
        self.webView = webView
        webView.translatesAutoresizingMaskIntoConstraints = false
        insertSubview(webView, belowSubview: toolbar)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: trailingAnchor),
            webView.topAnchor.constraint(equalTo: topAnchor),
            webView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    func apply(_ state: NativeEditorFormatState) {
        toolbar.apply(state)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard NativeMotionDiagnostics.isEnabled else { return }
        let offset = webView?.scrollView.contentOffset ?? .zero
        NativeMotionDiagnostics.shared.record(
            "native.editorHost.layout",
            "frame=\(NativeMotionDiagnostics.rect(convert(bounds, to: nil))) safe=\(String(describing: safeAreaInsets)) keyboardTop=\(keyboardLayoutGuide.layoutFrame.minY.rounded()) webOffset=\(String(format: "%.1f,%.1f", offset.x, offset.y))"
        )
    }
}

private final class NativeEditorToolbar: UIVisualEffectView {
    private let scrollView = UIScrollView()
    private let actionStack = UIStackView()
    private let fixedStack = UIStackView()
    private var buttons: [NativeEditorToolbarAction: UIButton] = [:]
    private let onAction: (NativeEditorToolbarAction) -> Void

    init(onAction: @escaping (NativeEditorToolbarAction) -> Void) {
        self.onAction = onAction
        super.init(effect: UIBlurEffect(style: .systemChromeMaterial))
        isHidden = true
        alpha = 0
        layer.cornerRadius = 17
        layer.cornerCurve = .continuous
        // Match .mobile-editor-toolbar: the surface itself clips its rounded
        // blur, while the outer view keeps the WebView's soft shadow visible.
        clipsToBounds = false
        layer.shadowColor = UIColor(Color.flowixMobileForeground).cgColor
        layer.shadowOpacity = 0.15
        layer.shadowRadius = 19
        layer.shadowOffset = CGSize(width: 0, height: 14)
        contentView.layer.cornerRadius = 17
        contentView.layer.cornerCurve = .continuous
        contentView.layer.masksToBounds = true
        contentView.layer.borderWidth = 1 / UIScreen.main.scale
        contentView.layer.borderColor = UIColor(Color.flowixMobileForeground)
            .withAlphaComponent(0.09).cgColor

        scrollView.showsHorizontalScrollIndicator = false
        scrollView.alwaysBounceHorizontal = false
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(scrollView)

        actionStack.axis = .horizontal
        actionStack.alignment = .center
        actionStack.spacing = 2
        actionStack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(actionStack)

        fixedStack.axis = .horizontal
        fixedStack.alignment = .center
        fixedStack.translatesAutoresizingMaskIntoConstraints = false
        fixedStack.layoutMargins = UIEdgeInsets(top: 0, left: 7, bottom: 0, right: 7)
        fixedStack.isLayoutMarginsRelativeArrangement = true
        fixedStack.layer.borderWidth = 0
        contentView.addSubview(fixedStack)

        let separator = UIView()
        separator.backgroundColor = UIColor(Color.flowixMobileHairline)
        separator.translatesAutoresizingMaskIntoConstraints = false
        fixedStack.addArrangedSubview(separator)
        NSLayoutConstraint.activate([
            separator.widthAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),
            separator.heightAnchor.constraint(equalToConstant: 46),
        ])

        for action in NativeEditorToolbarAction.allCases {
            if action == .attachment || action == .dismiss { continue }
            if action == .heading1 || action == .bulletList || action == .blockquote {
                actionStack.addArrangedSubview(groupSeparator())
            }
            actionStack.addArrangedSubview(makeButton(action))
        }
        actionStack.addArrangedSubview(makeButton(.attachment))
        fixedStack.addArrangedSubview(makeButton(.dismiss))

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 7),
            scrollView.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 7),
            scrollView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -7),
            scrollView.trailingAnchor.constraint(equalTo: fixedStack.leadingAnchor, constant: -5),
            actionStack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            actionStack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            actionStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            actionStack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            actionStack.heightAnchor.constraint(equalTo: scrollView.frameLayoutGuide.heightAnchor),
            fixedStack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            fixedStack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 7),
            fixedStack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -7),
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func apply(_ state: NativeEditorFormatState) {
        let wasHidden = isHidden
        if state.focused {
            isHidden = false
            if wasHidden {
                alpha = 0
                UIView.animate(withDuration: 0.14) { self.alpha = 1 }
            }
        } else if !isHidden {
            UIView.animate(withDuration: 0.12, animations: { self.alpha = 0 }) { _ in
                self.isHidden = true
            }
        }
        setActive(.bold, state.bold)
        setActive(.italic, state.italic)
        setActive(.heading1, state.heading == 1)
        setActive(.heading2, state.heading == 2)
        setActive(.bulletList, state.bulletList)
        setActive(.orderedList, state.orderedList)
        setActive(.taskList, state.taskList)
        setActive(.blockquote, state.blockquote)
        setActive(.codeBlock, state.codeBlock)
    }

    private func groupSeparator() -> UIView {
        let separator = UIView()
        separator.backgroundColor = .clear
        let line = UIView()
        line.backgroundColor = UIColor(Color.flowixMobileHairline)
        line.translatesAutoresizingMaskIntoConstraints = false
        separator.addSubview(line)
        NSLayoutConstraint.activate([
            separator.widthAnchor.constraint(equalToConstant: 5),
            separator.heightAnchor.constraint(equalToConstant: 34),
            line.centerXAnchor.constraint(equalTo: separator.centerXAnchor),
            line.centerYAnchor.constraint(equalTo: separator.centerYAnchor),
            line.widthAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),
            line.heightAnchor.constraint(equalToConstant: 34),
        ])
        return separator
    }

    private func makeButton(_ action: NativeEditorToolbarAction) -> UIButton {
        let button = UIButton(type: .system)
        let normalColor = UIColor(Color.flowixSecondary)
        button.tintColor = normalColor
        button.setTitleColor(normalColor, for: .normal)
        button.layer.cornerRadius = 10
        button.layer.cornerCurve = .continuous
        button.accessibilityLabel = action.accessibilityLabel
        button.addTarget(self, action: #selector(tapAction(_:)), for: .touchUpInside)
        if let title = action.title {
            button.setTitle(title, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
        } else {
            // Lucide's 18px / 1.8px WebView icons are closer to SF Symbols'
            // regular weight than the default semibold native treatment.
            let config = UIImage.SymbolConfiguration(pointSize: 18, weight: .regular)
            button.setImage(UIImage(systemName: action.symbolName, withConfiguration: config), for: .normal)
        }
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(equalToConstant: 44),
            button.heightAnchor.constraint(equalToConstant: 44),
        ])
        buttons[action] = button
        return button
    }

    @objc private func tapAction(_ sender: UIButton) {
        guard let action = buttons.first(where: { $0.value === sender })?.key else { return }
        onAction(action)
    }

    private func setActive(_ action: NativeEditorToolbarAction, _ active: Bool) {
        guard let button = buttons[action] else { return }
        let normalColor = UIColor(Color.flowixSecondary)
        let activeColor = UIColor(Color.flowixMobilePrimary)
        let activeForeground = UIColor(Color.flowixMobilePrimaryForeground)
        button.backgroundColor = active ? activeColor : .clear
        button.tintColor = active ? activeForeground : normalColor
        button.setTitleColor(active ? activeForeground : normalColor, for: .normal)
    }
}

private extension NativeEditorToolbarAction {
    var symbolName: String {
        switch self {
        case .bold: return "bold"
        case .italic: return "italic"
        case .bulletList: return "list.bullet"
        case .orderedList: return "list.number"
        case .taskList: return "checklist"
        case .blockquote: return "text.quote"
        case .codeBlock: return "chevron.left.forwardslash.chevron.right"
        case .attachment: return "paperclip"
        case .dismiss: return "keyboard.chevron.compact.down"
        case .heading1, .heading2: return ""
        }
    }

    var title: String? {
        switch self {
        case .heading1: return "H1"
        case .heading2: return "H2"
        default: return nil
        }
    }

    var accessibilityLabel: String {
        switch self {
        case .bold: return "粗体"
        case .italic: return "斜体"
        case .heading1: return "一级标题"
        case .heading2: return "二级标题"
        case .bulletList: return "无序列表"
        case .orderedList: return "有序列表"
        case .taskList: return "任务列表"
        case .blockquote: return "引用"
        case .codeBlock: return "代码块"
        case .attachment: return "添加附件"
        case .dismiss: return "收起键盘"
        }
    }
}

/// Opt-in trace for separating page-layout movement from WebView scrolling.
/// It is intentionally inert unless the app is launched with
/// `--motion-diagnostics`.
final class NativeMotionDiagnostics {
    static let shared = NativeMotionDiagnostics()
    static let isEnabled = ProcessInfo.processInfo.arguments.contains("--motion-diagnostics")

    private let startedAt = Date()
    private var entries: [String] = []
    private var lastPayloadBySource: [String: String] = [:]
    private let maximumEntries = 600

    private init() {}

    func record(_ source: String, _ payload: String) {
        guard Self.isEnabled else { return }
        // Layout passes are frequent. Keeping only actual geometry changes
        // makes a reproduced trace readable without losing movement.
        guard lastPayloadBySource[source] != payload || source.hasPrefix("keyboard") else { return }
        lastPayloadBySource[source] = payload
        let elapsed = Int(Date().timeIntervalSince(startedAt) * 1_000)
        let line = String(format: "%06dms %@ %@", elapsed, source, payload)
        entries.append(line)
        if entries.count > maximumEntries { entries.removeFirst(entries.count - maximumEntries) }
        print("[Flowix Motion] \(line)")
    }

    func recordWeb(_ motion: [String: Any]) {
        let payload = motion.keys.sorted().map { key in
            "\(key)=\(motion[key] ?? "nil")"
        }.joined(separator: " ")
        record("web", payload)
    }

    func snapshot() -> String {
        guard Self.isEnabled else { return "未启用运动诊断。请使用 --motion-diagnostics 启动。" }
        return entries.isEmpty ? "尚未记录到运动事件。" : entries.joined(separator: "\n")
    }

    static func rect(_ rect: CGRect) -> String {
        String(format: "x=%.1f y=%.1f w=%.1f h=%.1f", rect.origin.x, rect.origin.y, rect.width, rect.height)
    }
}

struct NativeMotionProbe: UIViewRepresentable {
    let name: String

    func makeUIView(context: Context) -> MotionProbeView {
        MotionProbeView(name: name)
    }

    func updateUIView(_ view: MotionProbeView, context: Context) {
        view.sample("update")
    }
}

final class MotionProbeView: UIView {
    private let name: String

    init(name: String) {
        self.name = name
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        backgroundColor = .clear
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        sample("layout")
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        sample("safeArea")
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        sample("window")
    }

    func sample(_ reason: String) {
        guard NativeMotionDiagnostics.isEnabled else { return }
        let frameInWindow = convert(bounds, to: nil)
        NativeMotionDiagnostics.shared.record(
            "native.\(name).\(reason)",
            "frame=\(NativeMotionDiagnostics.rect(frameInWindow)) safe=\(String(describing: safeAreaInsets))"
        )
    }
}
