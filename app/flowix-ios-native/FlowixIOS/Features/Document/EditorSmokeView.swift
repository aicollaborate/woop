import SwiftUI

/// Debug-only launch surface used by the simulator smoke command. It opens a
/// real memo immediately, so WebView loading can be verified without relying
/// on coordinate-based simulator taps.
struct EditorSmokeView: View {
    @State private var memo: MemoPreview?
    @State private var editorReady = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if let memo {
                NavigationStack {
                    DocumentView(memo: memo, runBridgeSmokeTest: true) {
                        editorReady = true
                    }
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Text(editorReady ? "Tiptap ready" : "加载编辑器…")
                                .font(.caption)
                                .foregroundStyle(editorReady ? Color.green : Color.flowixSecondary)
                        }
                    }
                }
            } else if let errorMessage {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.title)
                    Text("编辑器 smoke 失败")
                        .font(.headline)
                    Text(errorMessage)
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Color.flowixSecondary)
                }
                .padding(24)
            } else {
                ProgressView("打开笔记…")
            }
        }
        .task {
            await loadMemo()
        }
    }

    private func loadMemo() async {
        do {
            try await FlowixAPI.shared.initializeAsync()
            let snapshot = try await FlowixAPI.shared.librarySnapshotAsync()
            guard let first = snapshot.memos.first else {
                throw FlowixAPIError.native("没有可打开的笔记。")
            }
            memo = MemoPreview(nativeMemo: first)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
