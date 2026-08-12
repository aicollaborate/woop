import Foundation

struct MemoPreview: Identifiable, Hashable {
    let id: String
    let title: String
    let preview: String
    let updatedAt: String
    let createdAt: String
    let thumbnail: String?
    let tags: [String]
    let content: String
    let favorited: Bool

    var containsTodo: Bool {
        preview.contains("- [ ]") || preview.contains("[ ]")
    }
}

extension MemoPreview {
    init(nativeMemo: NativeMemo) {
        self.init(
            id: nativeMemo.id,
            title: nativeMemo.title,
            preview: nativeMemo.preview,
            updatedAt: Self.relativeDate(nativeMemo.updatedAt),
            createdAt: Self.relativeDate(nativeMemo.createdAt),
            thumbnail: nativeMemo.thumbnail,
            tags: nativeMemo.tags,
            content: "",
            favorited: nativeMemo.favorited
        )
    }

    private static func relativeDate(_ milliseconds: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1_000)
        let seconds = max(0, Date().timeIntervalSince(date))
        if seconds < 60 { return "刚刚" }
        if seconds < 3_600 { return String(Int(seconds / 60)) + " 分钟前" }
        if seconds < 86_400 { return String(Int(seconds / 3_600)) + " 小时前" }
        if seconds < 604_800 { return String(Int(seconds / 86_400)) + " 天前" }
        return date.formatted(.dateTime.year().month().day())
    }
}

extension MemoPreview {
    static let previews: [MemoPreview] = [
        MemoPreview(
            id: "native-preview-1",
            title: "开始使用 Flowix",
            preview: "记录想法、整理任务，并在设备之间同步。",
            updatedAt: "刚刚",
            createdAt: "刚刚",
            thumbnail: nil,
            tags: [],
            content: "# 开始使用 Flowix\n\n这是原生 Swift 页面中的 Tiptap 编辑器。\n\n- [ ] 试试任务列表\n- [ ] 输入一些 Markdown",
            favorited: false
        ),
        MemoPreview(
            id: "native-preview-2",
            title: "开发任务管理",
            preview: "原生客户端迁移计划和编辑器桥接。",
            updatedAt: "今天",
            createdAt: "今天",
            thumbnail: nil,
            tags: [],
            content: "# 开发任务管理\n\n原生页面负责导航和数据，Tiptap 负责富文本编辑。",
            favorited: false
        ),
    ]
}
