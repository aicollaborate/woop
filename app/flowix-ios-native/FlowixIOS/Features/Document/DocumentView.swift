import SwiftUI
import UIKit

struct DocumentView: View {
    let memo: MemoPreview
    var onEditorReady: () -> Void = {}
    var runBridgeSmokeTest = false
    @Environment(\.dismiss) private var dismiss
    @State private var content: String
    @State private var frontmatter = ""
    @State private var originalContent: String
    @State private var isDirty = false
    @State private var isSaving = false
    @State private var loadError: String?
    @State private var editorLoadError: String?
    @State private var editorOperationError: String?
    @State private var saveError: String?
    @State private var noticeMessage: String?
    @State private var editorReady = false
    @State private var editorReloadToken = 0
    @State private var smokeStatus = ""
    @State private var draftTask: Task<Void, Never>?
    @State private var autoSaveTask: Task<Void, Never>?
    @State private var pendingDraft: String?
    @State private var showingDraftRecovery = false
    @State private var conflictLocalContent = ""
    @State private var conflictRemoteContent = ""
    @State private var showingConflictResolution = false
    @State private var isLoaded = false

    init(
        memo: MemoPreview,
        runBridgeSmokeTest: Bool = false,
        onEditorReady: @escaping () -> Void = {}
    ) {
        self.memo = memo
        self.runBridgeSmokeTest = runBridgeSmokeTest
        self.onEditorReady = onEditorReady
        _content = State(initialValue: memo.content)
        _originalContent = State(initialValue: memo.content)
    }

    var body: some View {
        ZStack(alignment: .top) {
            // Paint the document surface independently from the safe-area-sized
            // editor stack so the home-indicator area cannot reveal a separate
            // block from the presenting page.
            Color.white.ignoresSafeArea()

            VStack(spacing: 0) {
                documentTopBar
                ZStack {
                    if let loadError {
                        DocumentFailureState(
                            title: "无法打开笔记",
                            message: loadError,
                            retryTitle: "重试"
                        ) {
                            Task { await load() }
                        }
                    } else if isLoaded {
                        editorSurface
                    } else {
                        NativeHalfCircleLoader()
                    }
                }
            }
            // The editor is the scrollable document surface.
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        // The keyboard must overlay this complete document page. Applying this
        // at the root prevents SwiftUI from translating the title bar while the
        // native EditorWebView toolbar independently follows its keyboard guide.
        .ignoresSafeArea(.container, edges: .bottom)
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .background(NativeMotionProbe(name: "documentPage"))
        .navigationBarHidden(true)
        .task {
            await load()
        }
        .alert("无法保存笔记", isPresented: Binding(
            get: { saveError != nil },
            set: { if !$0 { saveError = nil } }
        )) {
            Button("确定", role: .cancel) { saveError = nil }
        } message: {
            Text(saveError ?? "未知错误")
        }
        .alert("编辑器操作失败", isPresented: Binding(
            get: { editorOperationError != nil },
            set: { if !$0 { editorOperationError = nil } }
        )) {
            Button("确定", role: .cancel) { editorOperationError = nil }
        } message: {
            Text(editorOperationError ?? "未知错误")
        }
        .alert("提示", isPresented: Binding(
            get: { noticeMessage != nil },
            set: { if !$0 { noticeMessage = nil } }
        )) {
            Button("确定", role: .cancel) { noticeMessage = nil }
        } message: {
            Text(noticeMessage ?? "")
        }
        .confirmationDialog("发现本地草稿", isPresented: $showingDraftRecovery, titleVisibility: .visible) {
            Button("恢复草稿") {
                guard let pendingDraft else { return }
                applyDraft(pendingDraft)
                self.pendingDraft = nil
                scheduleDraftSave()
            }
            Button("丢弃草稿", role: .destructive) {
                try? DraftStore.remove(memoID: memo.id)
                pendingDraft = nil
            }
            Button("稍后处理", role: .cancel) {}
        } message: {
            Text("检测到尚未保存的本地编辑内容。")
        }
        .confirmationDialog("笔记内容发生冲突", isPresented: $showingConflictResolution, titleVisibility: .visible) {
            Button("保留本地内容") {
                originalContent = conflictRemoteContent
                isDirty = true
                scheduleDraftSave()
            }
            Button("使用远端内容", role: .destructive) {
                applyDocument(conflictRemoteContent)
                try? DraftStore.remove(memoID: memo.id)
            }
            Button("复制本地内容") {
                UIPasteboard.general.string = conflictLocalContent
                noticeMessage = "本地内容已复制到剪贴板。"
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("该笔记已在其他位置修改，请选择如何处理。")
        }
        .onDisappear {
            autoSaveTask?.cancel()
            scheduleDraftSave(immediate: true)
        }
    }

    private var documentTopBar: some View {
        HStack(spacing: 0) {
            Button {
                Task { await closeDocument() }
            } label: {
                Image(systemName: "arrow.left")
                    .font(.system(size: 21, weight: .medium))
                    .frame(width: 48, height: 48)
                    .foregroundStyle(Color.flowixSecondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("返回列表")
            Spacer()
            HStack(spacing: 4) {
                if NativeMotionDiagnostics.isEnabled {
                    Button {
                        UIPasteboard.general.string = NativeMotionDiagnostics.shared.snapshot()
                    } label: {
                        Image(systemName: "waveform.path.ecg")
                            .font(.system(size: 15, weight: .medium))
                            .frame(width: 36, height: 36)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.flowixSecondary)
                    .accessibilityLabel("复制运动诊断日志")
                }
                saveStatus
            }
            .padding(.horizontal, 8)
        }
        // 48px control + 5px vertical inset mirrors the WebView's 58px
        // document top bar inside the already-safe SwiftUI viewport.
        .padding(.horizontal, 6)
        .padding(.vertical, 5)
        .background(Color.white)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.flowixMobileHairline)
                .frame(height: 1)
        }
        .background(NativeMotionProbe(name: "documentTopBar"))
    }

    @ViewBuilder
    private var editorSurface: some View {
        if let editorLoadError {
            DocumentFailureState(
                title: "编辑器加载失败",
                message: editorLoadError,
                retryTitle: "重试编辑器"
            ) {
                retryEditor()
            }
        } else {
            ZStack(alignment: .topTrailing) {
                EditorWebView(
                    memoId: memo.id,
                    content: content,
                    onContentChanged: { nextContent in
                        content = nextContent
                        isDirty = joinDocumentContent(frontmatter: frontmatter, body: nextContent) != originalContent
                        scheduleDraftSave()
                        scheduleAutoSave()
                        if runBridgeSmokeTest,
                           nextContent.contains(Self.bridgeSmokeMarker),
                           smokeStatus == "等待 changed" {
                            smokeStatus = "已收到 changed，准备保存"
                            Task { await runBridgePersistenceSmoke() }
                        }
                    },
                    onReady: {
                        editorReady = true
                        if runBridgeSmokeTest { smokeStatus = "等待 changed" }
                        onEditorReady()
                    },
                    onError: { message in
                        if editorReady {
                            editorOperationError = message
                        } else {
                            editorLoadError = message
                        }
                    },
                    runBridgeSmokeTest: runBridgeSmokeTest
                )
                .id(editorReloadToken)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.white)

                // Keep the transport state visible during the native migration;
                // it is useful on simulator and can be removed once the bridge is
                // covered by UI tests.
                if runBridgeSmokeTest {
                    Text(editorReady ? "编辑器已连接" : "连接编辑器…")
                        .font(.caption2)
                        .foregroundStyle(editorReady ? Color.green : Color.flowixSecondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(.ultraThinMaterial, in: Capsule())
                        .padding(.top, 8)
                        .padding(.trailing, 8)
                }

                if runBridgeSmokeTest && !smokeStatus.isEmpty {
                    Text(smokeStatus)
                        .font(.caption2)
                        .foregroundStyle(Color.flowixSecondary)
                        .padding(.top, 42)
                        .padding(.trailing, 8)
                }
            }
        }
    }

    private func load() async {
        isLoaded = false
        editorReady = false
        loadError = nil
        editorLoadError = nil

        do {
            let opened = try await FlowixAPI.shared.openMemoAsync(id: memo.id)
            let parts = splitDocumentContent(opened.content)
            frontmatter = parts.frontmatter
            content = parts.body
            originalContent = opened.content
            isLoaded = true
            let draft = try? DraftStore.read(memoID: memo.id)
            if let draft, draft != opened.content {
                pendingDraft = draft
                showingDraftRecovery = true
            } else if draft == opened.content {
                try? DraftStore.remove(memoID: memo.id)
            }
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func retryEditor() {
        editorReady = false
        editorLoadError = nil
        editorReloadToken += 1
    }

    private func closeDocument() async {
        guard isLoaded else {
            dismiss()
            return
        }
        if await save() {
            dismiss()
        }
    }

    @discardableResult
    private func save() async -> Bool {
        guard isLoaded else { return true }
        guard isDirty else { return true }
        if isSaving {
            // A back tap during an auto-save shares the same save operation,
            // just like the WebView's savePromiseRef, instead of abandoning
            // the close request while the network call is still running.
            while isSaving {
                try? await Task.sleep(for: .milliseconds(40))
            }
            return !isDirty
        }
        autoSaveTask?.cancel()
        isSaving = true
        defer { isSaving = false }
        while isDirty {
            let fullContent = joinDocumentContent(frontmatter: frontmatter, body: content)
            do {
                let result = try await FlowixAPI.shared.writeDocumentAsync(
                    id: memo.id,
                    content: fullContent,
                    expectedContent: originalContent
                )
                // Do not replace a newer local edit that arrived while the
                // request was in flight. The WebView save loop keeps that edit
                // and writes it against the newly returned revision.
                let stillCurrent = joinDocumentContent(frontmatter: frontmatter, body: content) == fullContent
                originalContent = result.content
                if stillCurrent {
                    let parts = splitDocumentContent(result.content)
                    frontmatter = parts.frontmatter
                    content = parts.body
                }
                isDirty = !stillCurrent
                if stillCurrent {
                    draftTask?.cancel()
                    try? DraftStore.remove(memoID: memo.id)
                }
            } catch {
                if case FlowixAPIError.conflict = error {
                    let local = joinDocumentContent(frontmatter: frontmatter, body: content)
                    do {
                        let remote = try await FlowixAPI.shared.openMemoAsync(id: memo.id)
                        conflictLocalContent = local
                        conflictRemoteContent = remote.content
                        showingConflictResolution = true
                    } catch {
                        saveError = error.localizedDescription
                    }
                } else {
                    saveError = error.localizedDescription
                }
                return false
            }
        }
        return true
    }

    private func applyDocument(_ fullContent: String) {
        let parts = splitDocumentContent(fullContent)
        frontmatter = parts.frontmatter
        content = parts.body
        originalContent = fullContent
        isDirty = false
    }

    private func applyDraft(_ fullContent: String) {
        let parts = splitDocumentContent(fullContent)
        frontmatter = parts.frontmatter
        content = parts.body
        isDirty = fullContent != originalContent
    }

    private func scheduleDraftSave(immediate: Bool = false) {
        guard isLoaded else { return }
        draftTask?.cancel()
        let fullContent = joinDocumentContent(frontmatter: frontmatter, body: content)
        draftTask = Task {
            if !immediate {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled else { return }
            }
            guard fullContent != originalContent else { return }
            try? DraftStore.write(fullContent, memoID: memo.id)
        }
    }

    private func scheduleAutoSave() {
        guard isLoaded else { return }
        autoSaveTask?.cancel()
        autoSaveTask = Task {
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled else { return }
            await save()
        }
    }
}

private struct NativeHalfCircleLoader: View {
    var body: some View {
        // This used a repeating `withAnimation` in the document hierarchy.
        // Its 0.9 s transaction matched the page-wide vertical layout cycle
        // captured by the motion trace. The system indicator animates inside
        // UIKit without propagating an animation transaction to this page.
        ProgressView()
            .controlSize(.regular)
            .tint(Color.flowixAccent.opacity(0.5))
            .frame(width: 24, height: 24)
            .accessibilityLabel("正在打开笔记")
    }
}

private struct DocumentFailureState: View {
    let title: String
    let message: String
    let retryTitle: String
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 28, weight: .medium))
                .foregroundStyle(Color.flowixMobileDestructive)
            Text(title)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Color.flowixMobileForeground)
            Text(message)
                .font(.system(size: 14))
                .multilineTextAlignment(.center)
                .foregroundStyle(Color.flowixSecondary)
                .padding(.horizontal, 24)
            Button(retryTitle, action: onRetry)
                .buttonStyle(.borderedProminent)
                .tint(Color.flowixAccent)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.white)
    }
}

private extension DocumentView {
    @ViewBuilder
    var saveStatus: some View {
        if loadError != nil {
            Text("加载失败")
                .font(.system(size: 14))
                .foregroundStyle(Color.flowixMobileDestructive)
        } else if editorLoadError != nil {
            Text("编辑器失败")
                .font(.system(size: 14))
                .foregroundStyle(Color.flowixMobileDestructive)
        } else if isSaving {
            HStack(spacing: 4) {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 16, height: 16)
                Text("保存中")
            }
                .font(.system(size: 14))
                .foregroundStyle(Color.flowixSecondary)
        } else if showingConflictResolution {
            HStack(spacing: 4) {
                Image(systemName: "exclamationmark.icloud")
                    .font(.system(size: 16, weight: .medium))
                Text("发现同步冲突")
            }
                .font(.system(size: 14))
                .foregroundStyle(Color.flowixMobileDestructive)
        } else if saveError != nil {
            HStack(spacing: 4) {
                Image(systemName: "exclamationmark.icloud")
                    .font(.system(size: 16, weight: .medium))
                Text("保存失败")
            }
                .font(.system(size: 14))
                .foregroundStyle(Color.flowixMobileDestructive)
        } else if isDirty {
            Text("未保存")
                .font(.system(size: 14))
                .foregroundStyle(Color.flowixMobileForeground)
        } else {
            // Match the mobile WebView status: a compact 16px checkmark and
            // muted success tone instead of a prominent native green label.
            HStack(spacing: 4) {
                Image(systemName: "checkmark")
                    .font(.system(size: 16, weight: .medium))
                Text("已保存")
            }
                .font(.system(size: 14))
                .foregroundStyle(Color.flowixMobileSaved)
        }
    }
}

private extension DocumentView {
    static let bridgeSmokeMarker = "native-editor-bridge-smoke"

    func runBridgePersistenceSmoke() async {
        let baseline = originalContent
        let modified = joinDocumentContent(frontmatter: frontmatter, body: content)
        do {
            let saved = try await FlowixAPI.shared.writeDocumentAsync(
                id: memo.id,
                content: modified,
                expectedContent: baseline
            )
            let reopened = try await FlowixAPI.shared.openMemoAsync(id: memo.id)
            guard reopened.content.contains(Self.bridgeSmokeMarker) else {
                smokeStatus = "重开校验失败"
                return
            }

            _ = try await FlowixAPI.shared.writeDocumentAsync(
                id: memo.id,
                content: baseline,
                expectedContent: saved.content
            )
            originalContent = baseline
            let parts = splitDocumentContent(baseline)
            frontmatter = parts.frontmatter
            content = parts.body
            isDirty = false
            smokeStatus = "编辑、保存、重开闭环通过"
        } catch {
            smokeStatus = "保存校验失败：\(error.localizedDescription)"
        }
    }
}

private struct DocumentParts {
    let frontmatter: String
    let body: String
}

private func splitDocumentContent(_ content: String) -> DocumentParts {
    let lines = content.components(separatedBy: "\n")
    guard lines.first?.trimmingCharacters(in: .whitespacesAndNewlines) == "---",
          let closingIndex = lines.indices.dropFirst().first(where: { index in
              lines[index].trimmingCharacters(in: .whitespacesAndNewlines) == "---"
          }) else {
        return DocumentParts(frontmatter: "", body: content)
    }

    // `firstIndex` above is an index in the original array. The previous
    // implementation treated it as a zero-based offset after `dropFirst()`,
    // which consumed the first Markdown body line (normally `# 标题`) as if it
    // were part of frontmatter.
    let bodyStart = closingIndex + 1
    let frontmatter = lines[...closingIndex].joined(separator: "\n") + "\n"
    let body = lines.dropFirst(bodyStart).joined(separator: "\n")
    return DocumentParts(frontmatter: frontmatter, body: body)
}

private func joinDocumentContent(frontmatter: String, body: String) -> String {
    frontmatter + body
}
