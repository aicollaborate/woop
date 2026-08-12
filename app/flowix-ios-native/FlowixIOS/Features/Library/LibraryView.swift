import SwiftUI
import UIKit

@MainActor
final class LibraryModel: ObservableObject {
    @Published private(set) var memos: [MemoPreview] = []
    @Published private(set) var notebooks: [NativeNotebook] = []
    @Published private(set) var tags: [NativeTag] = []
    @Published private(set) var selectedNotebookId: String?
    @Published private(set) var cloudState: NativeCloudState?
    @Published private(set) var errorMessage: String?
    @Published private(set) var isSyncing = false

    var canSync: Bool {
        guard let state = cloudState else { return false }
        return state.authenticated
            && state.enabled
            && state.membership?.active == true
            && state.membership?.readOnly != true
    }

    func load() async {
        do {
            try await FlowixAPI.shared.initializeAsync()
            await refresh()
            await refreshCloudState()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func refreshCloudState() async {
        cloudState = try? await FlowixAPI.shared.cloudStateAsync()
    }

    @discardableResult
    func syncNow() async -> Bool {
        let available = canSync
        guard available, !isSyncing else { return available }

        isSyncing = true
        do {
            _ = try await FlowixAPI.shared.cloudSyncNowAsync()
            await refresh()
            await refreshCloudState()
            isSyncing = false
            return true
        } catch {
            errorMessage = error.localizedDescription
            isSyncing = false
            return true
        }
    }

    func refresh() async {
        do {
            let snapshot = try await FlowixAPI.shared.librarySnapshotAsync()
            notebooks = snapshot.notebooks
            tags = snapshot.tags
            selectedNotebookId = snapshot.selectedNotebookId
            memos = snapshot.memos.map(MemoPreview.init(nativeMemo:))
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func selectNotebook(_ id: String) async {
        do {
            try await FlowixAPI.shared.setCurrentNotebookAsync(id: id)
            await refresh()
        } catch { errorMessage = error.localizedDescription }
    }

    func createMemo() async {
        guard let notebookID = selectedNotebookId else { return }
        do {
            let title = "未命名笔记"
            _ = try await FlowixAPI.shared.createMemoAsync(
                notebookID: notebookID,
                title: title,
                content: "# \(title)\n\n"
            )
            await refresh()
        } catch { errorMessage = error.localizedDescription }
    }

    func deleteMemo(_ memo: MemoPreview) async {
        do {
            guard try await FlowixAPI.shared.deleteMemoAsync(id: memo.id) else { return }
            await refresh()
        } catch { errorMessage = error.localizedDescription }
    }

    func toggleFavorite(_ memo: MemoPreview) async {
        do {
            try await FlowixAPI.shared.setMemoFavoritedAsync(id: memo.id, favorited: !memo.favorited)
            await refresh()
        } catch { errorMessage = error.localizedDescription }
    }

    func createNotebook(name: String) async {
        do {
            try await FlowixAPI.shared.createNotebookAsync(name: name)
            await refresh()
        } catch { errorMessage = error.localizedDescription }
    }

    func renameNotebook(_ notebook: NativeNotebook, name: String) async {
        do {
            try await FlowixAPI.shared.renameNotebookAsync(id: notebook.id, name: name)
            await refresh()
        } catch { errorMessage = error.localizedDescription }
    }

    func deleteNotebook(_ notebook: NativeNotebook) async {
        do {
            try await FlowixAPI.shared.deleteNotebookAsync(id: notebook.id)
            await refresh()
        } catch { errorMessage = error.localizedDescription }
    }
}

struct LibraryView: View {
    @StateObject private var model = LibraryModel()
    @State private var searchOpen = false
    @State private var searchText = ""
    @State private var selectedTagId: String?
    @State private var navigationPageOpen = false
    @State private var pageDragOffset: CGFloat = 0
    @State private var accountOpen = false
    @State private var openActionsID: String?
    @State private var selectedMemo: MemoPreview?
    @State private var showingNewNotebook = false
    @State private var newNotebookName = ""
    @State private var notebookToRename: NativeNotebook?
    @State private var renameNotebookName = ""
    @State private var notebookToDelete: NativeNotebook?

    private var selectedNotebookName: String {
        model.notebooks.first(where: { $0.id == model.selectedNotebookId })?.name ?? "笔记"
    }

    private var visibleMemos: [MemoPreview] {
        var result = model.memos
        if let tagID = selectedTagId {
            result = result.filter { memo in
                memo.tags.contains { $0 == tagID || $0.hasPrefix(tagID + "/") }
            }
        }
        guard !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return result }
        return result.filter {
            $0.title.localizedCaseInsensitiveContains(searchText)
                || $0.preview.localizedCaseInsensitiveContains(searchText)
                || $0.tags.contains { $0.localizedCaseInsensitiveContains(searchText) }
        }
    }

    private var heading: String {
        let name = model.tags.first(where: { $0.id == selectedTagId })?.name
            ?? (selectedTagId == nil ? selectedNotebookName : "标签")
        return name + "  " + String(visibleMemos.count)
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.flowixBackground.ignoresSafeArea()

            GeometryReader { proxy in
                HStack(spacing: 0) {
                    NativeNavigationPage(
                        notebooks: model.notebooks,
                        tags: model.tags,
                        selectedNotebookId: model.selectedNotebookId,
                        selectedTagId: selectedTagId,
                        cloudState: model.cloudState,
                        onOpenAccount: { accountOpen = true },
                        onClose: {
                            withAnimation(.easeInOut(duration: 0.28)) {
                                navigationPageOpen = false
                            }
                        },
                        onSelectNotebook: { id in
                            Task {
                                await model.selectNotebook(id)
                                selectedTagId = nil
                                withAnimation(.easeInOut(duration: 0.28)) {
                                    navigationPageOpen = false
                                }
                            }
                        },
                        onSelectTag: { id in
                            selectedTagId = id
                            withAnimation(.easeInOut(duration: 0.28)) {
                                navigationPageOpen = false
                            }
                        },
                        onCreateNotebook: {
                            newNotebookName = ""
                            showingNewNotebook = true
                        },
                        onRenameNotebook: { notebook in
                            renameNotebookName = notebook.name
                            notebookToRename = notebook
                        },
                        onDeleteNotebook: { notebook in
                            notebookToDelete = notebook
                        }
                    )
                    .frame(width: proxy.size.width, height: proxy.size.height)

                    VStack(spacing: 0) {
                        if searchOpen {
                            searchBar
                        } else {
                            topBar
                        }
                        memoList
                    }
                    .frame(width: proxy.size.width, height: proxy.size.height)
                }
                .frame(width: proxy.size.width * 2, height: proxy.size.height, alignment: .leading)
                .offset(x: (navigationPageOpen ? 0 : -proxy.size.width) + pageDragOffset)
                .animation(.easeInOut(duration: 0.28), value: navigationPageOpen)
                .contentShape(Rectangle())
                .simultaneousGesture(
                DragGesture(minimumDistance: 12)
                    .onChanged { value in
                        // An open memo action tray owns the horizontal gesture.
                        // Otherwise a rightward close swipe is also interpreted
                        // as the navigation-page swipe.
                        guard openActionsID == nil else { return }
                        guard abs(value.translation.width) > abs(value.translation.height) else { return }

                        let width = max(proxy.size.width, 1)
                        let translation = value.translation.width
                        let allowedTranslation = navigationPageOpen
                            ? min(0, translation)
                            : max(0, translation)
                        pageDragOffset = min(width, max(-width, allowedTranslation))
                    }
                    .onEnded { value in
                        guard openActionsID == nil else {
                            withAnimation(.easeOut(duration: 0.2)) { pageDragOffset = 0 }
                            return
                        }
                        let width = max(proxy.size.width, 1)
                        guard abs(value.translation.width) > abs(value.translation.height) else {
                            withAnimation(.easeOut(duration: 0.2)) { pageDragOffset = 0 }
                            return
                        }

                        let predictedTranslation = navigationPageOpen
                            ? min(0, value.predictedEndTranslation.width)
                            : max(0, value.predictedEndTranslation.width)
                        let progress = abs(pageDragOffset) / width
                        let shouldSwitch = progress >= 0.25 || abs(predictedTranslation) >= width * 0.35
                        let nextOpen = navigationPageOpen ? !shouldSwitch : shouldSwitch

                        withAnimation(.interactiveSpring(response: 0.28, dampingFraction: 0.86)) {
                            navigationPageOpen = nextOpen
                            pageDragOffset = 0
                        }
                    }
                )
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // The pages paint their own bottom safe-area backgrounds. Clipping
            // the slider to GeometryReader's safe-area height exposes the
            // presenting root background as a separate strip at the bottom.
            .overlay(alignment: .bottomTrailing) {
                if !navigationPageOpen && !accountOpen {
                    fab
                }
            }

            if let errorMessage = model.errorMessage, model.memos.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 25))
                    Text("无法加载笔记")
                        .font(.system(size: 17, weight: .semibold))
                    Text(errorMessage)
                        .font(.system(size: 12))
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Color.flowixSecondary)
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.flowixBackground)
            }
        }
        // UIKit owns the sheet's pan recognizer.  Unlike a SwiftUI gesture
        // layered on a ScrollView, it hands a downward drag from the content
        // to the sheet exactly when the content reaches its top edge.
        .sheet(isPresented: $accountOpen, onDismiss: refreshAfterAccountDismissal) {
            AccountView(onClose: { accountOpen = false })
                .presentationDetents([.fraction(0.8)])
                .presentationDragIndicator(.visible)
        }
        .navigationBarHidden(true)
        .navigationDestination(
            isPresented: Binding(
                get: { selectedMemo != nil },
                set: { if !$0 { selectedMemo = nil } }
            )
        ) {
            if let selectedMemo {
                DocumentView(memo: selectedMemo)
                    .navigationBarHidden(true)
            } else {
                EmptyView()
            }
        }
        .task { await model.load() }
        .alert("新建笔记本", isPresented: $showingNewNotebook) {
            TextField("笔记本名称", text: $newNotebookName)
            Button("创建") {
                let name = newNotebookName.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty else { return }
                Task { await model.createNotebook(name: name) }
            }
            Button("取消", role: .cancel) {}
        }
        .alert("重命名笔记本", isPresented: Binding(
            get: { notebookToRename != nil },
            set: { if !$0 { notebookToRename = nil } }
        )) {
            TextField("笔记本名称", text: $renameNotebookName)
            Button("保存") {
                guard let notebook = notebookToRename else { return }
                let name = renameNotebookName.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty else { return }
                Task { await model.renameNotebook(notebook, name: name) }
                notebookToRename = nil
            }
            Button("取消", role: .cancel) { notebookToRename = nil }
        }
        .confirmationDialog(
            "删除笔记本？",
            isPresented: Binding(get: { notebookToDelete != nil }, set: { if !$0 { notebookToDelete = nil } }),
            titleVisibility: .visible,
            presenting: notebookToDelete
        ) { notebook in
            Button("删除“" + notebook.name + "”", role: .destructive) {
                Task { await model.deleteNotebook(notebook) }
                notebookToDelete = nil
            }
            Button("取消", role: .cancel) {}
        } message: { _ in
            Text("其中的全部笔记会从此设备删除。")
        }
    }

    private var topBar: some View {
        ZStack {
            VStack(spacing: 1) {
                Text(heading)
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(Color.flowixForeground)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 76)
            .allowsHitTesting(false)

            HStack(spacing: 8) {
                Button {
                    withAnimation(.easeInOut(duration: 0.28)) { navigationPageOpen = true }
                } label: {
                    NativeMobileSVGIconView(icon: .menu, color: "#1F2937")
                        .frame(width: 21, height: 21)
                }
                .buttonStyle(NativeCircleButtonStyle(size: 48))
                .accessibilityLabel("打开导航")

                Spacer(minLength: 0)

                // Cloud and search are two independent 44pt circular actions;
                // keep a normal visual gap between their touch targets.
                HStack(spacing: 8) {
                    Button {
                        if model.canSync {
                            Task { await model.syncNow() }
                        } else {
                            accountOpen = true
                        }
                    } label: {
                        NativeCloudStatusIcon(status: cloudStatus)
                            .frame(width: 20, height: 20)
                    }
                    .disabled(model.isSyncing)
                    .buttonStyle(NativeCircleButtonStyle())
                    .accessibilityLabel(cloudAccessibilityLabel)
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) { searchOpen = true }
                    } label: {
                        NativeMobileSVGIconView(icon: .search, color: "#1F2937")
                            .frame(width: 21, height: 21)
                    }
                    .buttonStyle(NativeCircleButtonStyle())
                    .accessibilityLabel("搜索笔记")
                }
            }
        }
        .padding(.horizontal, 9)
        .padding(.top, 5)
        .padding(.bottom, 5)
        // Keep the library chrome on the exact same opaque surface as the
        // memo rows below; the translucent top bar was creating a visible
        // color shift against the content background.
        .background(Color.flowixBackground)
    }

    private func refreshAfterAccountDismissal() {
        Task {
            await model.refresh()
            await model.refreshCloudState()
        }
    }

    private var searchBar: some View {
        HStack(spacing: 8) {
            NativeMobileSVGIconView(icon: .search, color: "#6E737A")
                .frame(width: 19, height: 19)
            TextField("搜索当前笔记本", text: $searchText)
                .font(.system(size: 16))
                .textInputAutocapitalization(.never)
                .submitLabel(.search)
            if !searchText.isEmpty {
                Button { searchText = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Color.flowixSecondary)
                }
            }
            Button {
                searchText = ""
                withAnimation(.easeInOut(duration: 0.2)) { searchOpen = false }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 18, weight: .medium))
                    .frame(width: 34, height: 34)
                    .foregroundStyle(Color.flowixAccent)
            }
            .accessibilityLabel("关闭搜索")
        }
        .padding(.horizontal, 14)
        .frame(height: 46)
        .background(Color.white, in: Capsule())
        .shadow(color: .black.opacity(0.05), radius: 10, y: 3)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
    }

    private var memoList: some View {
        NativeRefreshableScrollView(onRefresh: {
            await model.refresh()
        }) {
            LazyVStack(spacing: 0) {
                if visibleMemos.isEmpty {
                    NativeEmptyState(searching: !searchText.isEmpty)
                } else {
                    ForEach(visibleMemos) { memo in
                        NativeMemoSwipeRow(
                            memo: memo,
                            actionsOpen: openActionsID == memo.id,
                            onOpenActions: { id in openActionsID = id },
                            onOpen: {
                                openActionsID = nil
                                selectedMemo = memo
                            },
                            onDelete: {
                                openActionsID = nil
                                Task { await model.deleteMemo(memo) }
                            },
                            onToggleFavorite: {
                                openActionsID = nil
                                Task { await model.toggleFavorite(memo) }
                            }
                        )
                    }
                }
            }
            .padding(.horizontal, 28)
            .padding(.bottom, 100)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var fab: some View {
        Button { Task { await model.createMemo() } } label: {
            NativeMobileSVGIconView(icon: .squarePen, color: "#FFFFFF")
                .frame(width: 24, height: 24)
                .frame(width: 58, height: 58)
                .background(Color.flowixAccent, in: Circle())
                .shadow(color: Color.flowixAccent.opacity(0.22), radius: 14, y: 7)
        }
        .disabled(model.selectedNotebookId == nil)
        .opacity(model.selectedNotebookId == nil ? 0.4 : 1)
        .padding(.trailing, 18)
        .padding(.bottom, 20)
    }

    private var cloudStatus: NativeCloudStatus {
        if model.isSyncing { return .connecting }
        return model.canSync ? .connected : .unlinked
    }

    private var cloudAccessibilityLabel: String {
        if model.isSyncing { return "正在同步 Cloud" }
        if model.canSync { return "已连接 Cloud，点击同步" }
        return "未连接 Cloud，打开账号与云同步"
    }
}

/// A native UIScrollView + UIRefreshControl bridge used for the library list.
/// SwiftUI's `.refreshable` is ideal for a standalone ScrollView, but this list
/// lives inside a horizontally paging container and also contains horizontal
/// swipe rows. Keeping the refresh control on the actual UIScrollView gives
/// UIKit ownership of the vertical pan, bounce and refresh threshold.
private struct NativeRefreshableScrollView<Content: View>: UIViewRepresentable {
    let onRefresh: () async -> Void
    let content: Content

    init(
        onRefresh: @escaping () async -> Void,
        @ViewBuilder content: () -> Content
    ) {
        self.onRefresh = onRefresh
        self.content = content()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onRefresh: onRefresh)
    }

    func makeUIView(context: Context) -> UIScrollView {
        let scrollView = UIScrollView(frame: .zero)
        scrollView.alwaysBounceVertical = true
        scrollView.bounces = true
        scrollView.showsVerticalScrollIndicator = false
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.backgroundColor = .clear

        let refreshControl = UIRefreshControl()
        // Keep UIKit's refresh threshold and accessibility behavior, but use
        // the same restrained loading treatment as the native document view.
        refreshControl.tintColor = .clear
        let refreshIndicator = NativeRefreshIndicator()
        refreshIndicator.translatesAutoresizingMaskIntoConstraints = false
        refreshControl.addSubview(refreshIndicator)
        NSLayoutConstraint.activate([
            refreshIndicator.centerXAnchor.constraint(equalTo: refreshControl.centerXAnchor),
            refreshIndicator.centerYAnchor.constraint(equalTo: refreshControl.centerYAnchor),
            refreshIndicator.widthAnchor.constraint(equalToConstant: 24),
            refreshIndicator.heightAnchor.constraint(equalToConstant: 24),
        ])
        context.coordinator.refreshIndicator = refreshIndicator
        refreshControl.addTarget(
            context.coordinator,
            action: #selector(Coordinator.handleRefresh(_:)),
            for: .valueChanged
        )
        scrollView.refreshControl = refreshControl

        let hostingController = UIHostingController(rootView: content)
        // The scroll view's content height is provided by the hosted SwiftUI
        // view.  Without the intrinsic sizing option, a UIHostingController
        // can report no usable height for a short/empty LazyVStack, leaving
        // UIScrollView with no vertical content area to bounce or refresh.
        hostingController.sizingOptions = [.intrinsicContentSize]
        hostingController.view.translatesAutoresizingMaskIntoConstraints = false
        hostingController.view.backgroundColor = .clear
        hostingController.view.setContentHuggingPriority(.required, for: .vertical)
        hostingController.view.setContentCompressionResistancePriority(.required, for: .vertical)
        context.coordinator.hostingController = hostingController
        scrollView.addSubview(hostingController.view)

        NSLayoutConstraint.activate([
            hostingController.view.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            hostingController.view.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            hostingController.view.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            hostingController.view.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            hostingController.view.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor),
        ])

        return scrollView
    }

    func updateUIView(_ scrollView: UIScrollView, context: Context) {
        context.coordinator.onRefresh = onRefresh
        context.coordinator.hostingController?.rootView = content
        context.coordinator.hostingController?.view.invalidateIntrinsicContentSize()
        scrollView.setNeedsLayout()
    }

    final class Coordinator: NSObject {
        var onRefresh: () async -> Void
        var hostingController: UIHostingController<Content>?
        weak var refreshIndicator: NativeRefreshIndicator?
        private var refreshTask: Task<Void, Never>?

        init(onRefresh: @escaping () async -> Void) {
            self.onRefresh = onRefresh
        }

        @objc func handleRefresh(_ sender: UIRefreshControl) {
            refreshTask?.cancel()
            refreshIndicator?.startAnimating()
            let action = onRefresh
            refreshTask = Task { @MainActor [weak self, weak sender] in
                await action()
                self?.refreshIndicator?.stopAnimating()
                sender?.endRefreshing()
                self?.refreshTask = nil
            }
        }

        deinit {
            refreshTask?.cancel()
        }
    }
}

/// A three-quarter circular refresh indicator. UIRefreshControl still owns
/// the pull threshold; this view only replaces UIKit's default glyph.
private final class NativeRefreshIndicator: UIView {
    private let shapeLayer = CAShapeLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        shapeLayer.fillColor = UIColor.clear.cgColor
        shapeLayer.strokeColor = UIColor(Color.flowixMobileForeground).cgColor
        shapeLayer.lineWidth = 2.2
        shapeLayer.lineCap = .round
        layer.addSublayer(shapeLayer)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let inset = shapeLayer.lineWidth / 2
        let radius = min(bounds.width, bounds.height) / 2 - inset
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        let path = UIBezierPath(
            arcCenter: center,
            radius: max(0, radius),
            startAngle: -.pi / 2,
            endAngle: .pi,
            clockwise: true
        )
        shapeLayer.frame = bounds
        shapeLayer.path = path.cgPath
    }

    func startAnimating() {
        guard shapeLayer.animation(forKey: "flowix.refresh.rotation") == nil else { return }
        let animation = CABasicAnimation(keyPath: "transform.rotation")
        animation.fromValue = 0
        animation.toValue = Double.pi * 2
        animation.duration = 0.8
        animation.repeatCount = .infinity
        animation.timingFunction = CAMediaTimingFunction(name: .linear)
        shapeLayer.add(animation, forKey: "flowix.refresh.rotation")
    }

    func stopAnimating() {
        shapeLayer.removeAnimation(forKey: "flowix.refresh.rotation")
    }
}

/// A UIKit directional pan bridge for memo rows.
///
/// A SwiftUI DragGesture still participates in gesture arbitration before its
/// callback can determine that the movement is vertical. That is enough to
/// interrupt the enclosing UIScrollView. This recognizer rejects vertical
/// movement in `gestureRecognizerShouldBegin`, so the list's native pan owns
/// every vertical drag while the row keeps its interactive horizontal swipe.
private struct NativeHorizontalSwipeBridge: UIViewRepresentable {
    let onChanged: (CGFloat) -> Void
    let onEnded: (CGFloat, CGFloat) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onChanged: onChanged, onEnded: onEnded)
    }

    func makeUIView(context: Context) -> BridgeView {
        let view = BridgeView(coordinator: context.coordinator)
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: BridgeView, context: Context) {
        context.coordinator.onChanged = onChanged
        context.coordinator.onEnded = onEnded
        context.coordinator.attachIfNeeded(to: view)
    }

    final class BridgeView: UIView {
        let coordinator: Coordinator

        init(coordinator: Coordinator) {
            self.coordinator = coordinator
            super.init(frame: .zero)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        override func didMoveToSuperview() {
            super.didMoveToSuperview()
            coordinator.attachIfNeeded(to: self)
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            coordinator.updateRowFrame(for: self)
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var onChanged: (CGFloat) -> Void
        var onEnded: (CGFloat, CGFloat) -> Void
        weak var scrollView: UIScrollView?
        private weak var bridgeView: BridgeView?
        private var panGesture: UIPanGestureRecognizer?
        private var rowFrame: CGRect = .zero

        init(
            onChanged: @escaping (CGFloat) -> Void,
            onEnded: @escaping (CGFloat, CGFloat) -> Void
        ) {
            self.onChanged = onChanged
            self.onEnded = onEnded
        }

        func attachIfNeeded(to bridgeView: BridgeView) {
            self.bridgeView = bridgeView
            guard panGesture == nil else {
                updateRowFrame(for: bridgeView)
                return
            }

            var ancestor = bridgeView.superview
            while let view = ancestor {
                if let scrollView = view as? UIScrollView {
                    let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
                    pan.delegate = self
                    pan.cancelsTouchesInView = false
                    scrollView.addGestureRecognizer(pan)
                    self.scrollView = scrollView
                    self.panGesture = pan
                    updateRowFrame(for: bridgeView)
                    return
                }
                ancestor = view.superview
            }

            DispatchQueue.main.async { [weak self, weak bridgeView] in
                guard let self, let bridgeView else { return }
                self.attachIfNeeded(to: bridgeView)
            }
        }

        func updateRowFrame(for bridgeView: BridgeView) {
            guard let scrollView else { return }
            rowFrame = bridgeView.convert(bridgeView.bounds, to: scrollView)
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer,
                  let scrollView,
                  rowFrame != .zero else { return false }

            if let bridgeView {
                rowFrame = bridgeView.convert(bridgeView.bounds, to: scrollView)
            }

            let velocity = pan.velocity(in: scrollView)
            guard abs(velocity.x) > abs(velocity.y) * 1.2 else { return false }
            return rowFrame.contains(pan.location(in: scrollView))
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            // Let UIScrollView continue its normal arbitration. The custom
            // recognizer has already rejected vertical movement above.
            otherGestureRecognizer is UIPanGestureRecognizer
        }

        @objc private func handlePan(_ recognizer: UIPanGestureRecognizer) {
            guard let scrollView else { return }
            let translation = recognizer.translation(in: scrollView)
            let velocity = recognizer.velocity(in: scrollView)

            switch recognizer.state {
            case .began, .changed:
                onChanged(translation.x)
            case .ended:
                onEnded(translation.x, velocity.x)
            default:
                break
            }
        }

        deinit {
            if let panGesture, let scrollView {
                scrollView.removeGestureRecognizer(panGesture)
            }
        }
    }
}

/// The shared circular icon treatment used by the mobile list actions.
/// Keep the hit target at Apple's recommended minimum while the visual icon
/// remains optically smaller inside the circle.
private struct NativeCircleButtonStyle: ButtonStyle {
    let size: CGFloat

    init(size: CGFloat = 44) {
        self.size = size
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(width: size, height: size)
            .background(
                configuration.isPressed
                    ? Color.flowixMobileMuted
                    : Color.flowixMobileCard,
                in: Circle()
            )
            .overlay {
                Circle()
                    .strokeBorder(Color.white.opacity(0.82), lineWidth: 1)
            }
            .shadow(
                color: Color.black.opacity(configuration.isPressed ? 0.025 : 0.07),
                radius: configuration.isPressed ? 2 : 6,
                y: configuration.isPressed ? 1 : 3
            )
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .contentShape(Circle())
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

private struct NativeEmptyState: View {
    let searching: Bool

    var body: some View {
        VStack(spacing: 8) {
            if searching {
                NativeMobileSVGIconView(icon: .search, color: "#59636F")
                    .frame(width: 30, height: 30)
                    .frame(width: 64, height: 64)
                    .background(Color.flowixCard, in: RoundedRectangle(cornerRadius: 21))
                    .shadow(color: .black.opacity(0.05), radius: 12, y: 4)
            } else {
                Image(systemName: "book.closed")
                    .font(.system(size: 30, weight: .light))
                    .frame(width: 64, height: 64)
                    .foregroundStyle(Color.flowixAccent.opacity(0.8))
                    .background(Color.flowixCard, in: RoundedRectangle(cornerRadius: 21))
                    .shadow(color: .black.opacity(0.05), radius: 12, y: 4)
            }
            Text(searching ? "没有找到匹配的笔记" : "这里还没有笔记")
                .font(.system(size: 15, weight: .semibold))
            Text(searching ? "试试其他关键词" : "点击右下角开始记录")
                .font(.system(size: 12))
                .foregroundStyle(Color.flowixSecondary)
        }
        .frame(maxWidth: .infinity, minHeight: 480)
    }
}

private struct NativeMemoSwipeRow: View {
    private enum SwipeLock {
        case undecided
        case horizontal
        case vertical
    }

    private let actionsWidth: CGFloat = 108
    private let actionGap: CGFloat = 4
    private let activationDistance: CGFloat = 10
    private let commitDistance: CGFloat = 48
    private let maxOvershoot: CGFloat = 24
    private let settleDuration: Double = 0.22

    let memo: MemoPreview
    let actionsOpen: Bool
    let onOpenActions: (String?) -> Void
    let onOpen: () -> Void
    let onDelete: () -> Void
    let onToggleFavorite: () -> Void
    @State private var offset: CGFloat
    @State private var gestureStart: CGFloat = 0
    @State private var gestureLock: SwipeLock = .undecided
    @State private var isSwiping = false
    @State private var isSettling = false
    @State private var suppressTap = false

    init(
        memo: MemoPreview,
        actionsOpen: Bool,
        onOpenActions: @escaping (String?) -> Void,
        onOpen: @escaping () -> Void,
        onDelete: @escaping () -> Void,
        onToggleFavorite: @escaping () -> Void
    ) {
        self.memo = memo
        self.actionsOpen = actionsOpen
        self.onOpenActions = onOpenActions
        self.onOpen = onOpen
        self.onDelete = onDelete
        self.onToggleFavorite = onToggleFavorite
        _offset = State(initialValue: actionsOpen ? -actionsWidth : 0)
        _gestureStart = State(initialValue: actionsOpen ? -actionsWidth : 0)
    }

    var body: some View {
        ZStack(alignment: .trailing) {
            HStack(spacing: actionGap) {
                Button(action: onToggleFavorite) {
                    NativeMobileSVGIconView(icon: memo.favorited ? .pushPinFill : .pushPinRegular, color: "#FFFFFF")
                        .frame(width: 18, height: 18)
                        .frame(maxWidth: .infinity)
                        .frame(maxHeight: .infinity)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(memo.favorited ? "取消置顶" : "置顶")
                .background(Color.flowixMobilePrimary, in: RoundedRectangle(cornerRadius: 9))
                Button(role: .destructive, action: onDelete) {
                    NativeMobileSVGIconView(icon: .trashSimpleRegular, color: "#FFFFFF")
                        .frame(width: 18, height: 18)
                        .frame(maxWidth: .infinity)
                        .frame(maxHeight: .infinity)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("删除")
                .background(Color.flowixMobileDestructive, in: RoundedRectangle(cornerRadius: 9))
            }
            .frame(width: revealedActionsWidth)
            .clipped()
            .frame(maxHeight: .infinity, alignment: .trailing)
            .foregroundStyle(Color.white)
            .font(.system(size: 10, weight: .semibold))
            .opacity(actionProgress)
            // The action tray must sit above the translated memo button. Keep
            // it tappable as soon as the open state is committed, including
            // during the final snap animation.
            .zIndex(1)
            .allowsHitTesting(actionsOpen && !isSwiping)

            Button {
                if suppressTap {
                    suppressTap = false
                    return
                }
                onOpen()
            } label: {
                memoContent
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.flowixBackground)
            }
            .buttonStyle(.plain)
            .zIndex(0)
            .offset(x: offset)
        }
        .frame(minHeight: 104)
        .clipShape(RoundedRectangle(cornerRadius: 9))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.black.opacity(0.07))
                .frame(height: 1)
        }
        .onChange(of: actionsOpen) { open in
            guard !isSwiping && !isSettling else { return }
            withAnimation(snapAnimation) {
                offset = open ? -actionsWidth : 0
            }
            gestureStart = open ? -actionsWidth : 0
            isSettling = false
        }
        .background {
            NativeHorizontalSwipeBridge(
                onChanged: handleSwipeChanged,
                onEnded: handleSwipeEnded
            )
        }
    }

    private var actionProgress: Double {
        Double(min(1, max(0, -min(offset, 0) / actionsWidth)))
    }

    private var revealedActionsWidth: CGFloat {
        min(actionsWidth, max(0, -offset))
    }

    private var snapAnimation: Animation {
        .timingCurve(0.32, 0.72, 0, 1, duration: settleDuration)
    }

    private func rubberBand(_ value: CGFloat) -> CGFloat {
        if value > 0 {
            return min(value * 0.2, maxOvershoot)
        }
        if value < -actionsWidth {
            return max(
                -actionsWidth - (abs(value) - actionsWidth) * 0.2,
                -actionsWidth - maxOvershoot
            )
        }
        return value
    }

    private func handleSwipeChanged(_ translation: CGFloat) {
        isSettling = false
        if gestureLock == .undecided {
            gestureLock = .horizontal
            isSwiping = true
        }
        guard gestureLock == .horizontal else { return }
        offset = rubberBand(gestureStart + translation)
    }

    private func handleSwipeEnded(_ translation: CGFloat, _ velocity: CGFloat) {
        guard gestureLock == .horizontal else {
            gestureLock = .undecided
            isSwiping = false
            return
        }

        suppressTap = true
        // UIKit exposes translation and velocity rather than SwiftUI's
        // predictedEndTranslation. This short projection preserves the
        // familiar interactive swipe threshold without affecting vertical
        // scrolling, which never reaches this callback.
        let projectedTranslation = translation + velocity * 0.1
        let targetOpen = actionsOpen
            ? projectedTranslation < commitDistance
            : projectedTranslation < -commitDistance
        settle(to: targetOpen)
        gestureLock = .undecided
        isSwiping = false
    }

    private func settle(to targetOpen: Bool) {
        let targetOffset = targetOpen ? -actionsWidth : 0
        isSettling = true
        withAnimation(snapAnimation) {
            offset = targetOffset
        }
        if targetOpen != actionsOpen {
            onOpenActions(targetOpen ? memo.id : nil)
        }
        gestureStart = targetOffset
        DispatchQueue.main.asyncAfter(deadline: .now() + settleDuration) {
            isSettling = false
        }
        clearTapSuppressionAfterGesture()
    }

    private func clearTapSuppressionAfterGesture() {
        DispatchQueue.main.asyncAfter(deadline: .now() + settleDuration + 0.08) {
            suppressTap = false
        }
    }

    private var memoContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Matches .mobile-memo-row__title strong: 17px, semibold
            // (the closest native system weight to WebView's 650), tight
            // tracking and a 1.35 line height.
            Text(memo.title)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.flowixForeground)
                .tracking(-0.2)
                .lineSpacing(3)
                .lineLimit(2)

            // WebView: margin-top 6px, 15px text, 1.5 line height.
            Text(memo.preview.isEmpty ? "记录自己的想法" : memo.preview)
                .font(.system(size: 15))
                .foregroundStyle(Color.flowixSecondary)
                .lineSpacing(4)
                .lineLimit(2)
                .padding(.top, 6)

            if let thumbnail = memo.thumbnail {
                NativeThumbnail(value: thumbnail)
                    .frame(width: 120, height: 67.5)
                    .background(Color.flowixMobileMuted, in: RoundedRectangle(cornerRadius: 9))
                    .overlay {
                        RoundedRectangle(cornerRadius: 9)
                            .stroke(Color.flowixMobileHairline, lineWidth: 1)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 9))
                    .padding(.top, 10)
            }

            // WebView: metadata starts 9px after the preview/thumbnail and
            // keeps 10px between tag and detail rows.
            VStack(alignment: .leading, spacing: 10) {
                if !memo.tags.isEmpty {
                    HStack(spacing: 5) {
                        ForEach(memo.tags.prefix(3), id: \.self) { tag in
                            Text("#" + tag)
                                .font(.system(size: 13))
                                .foregroundStyle(Color.flowixSecondary)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 2)
                                .frame(minHeight: 20)
                                .background(Color.black.opacity(0.05), in: Capsule())
                        }
                    }
                }
                HStack(spacing: 5) {
                    Text(memo.createdAt)
                        .font(.system(size: 13))
                        .monospacedDigit()
                    if memo.favorited {
                        NativeMobileSVGIconView(icon: .pushPinFill, color: "#AD5138")
                            .frame(width: 14, height: 14)
                            .foregroundStyle(Color.flowixMobileBrand)
                    }
                }
                .foregroundStyle(Color.flowixMobileMutedForeground.opacity(0.82))
            }
            .padding(.top, 9)
        }
        .padding(.vertical, 15)
        .contentShape(Rectangle())
    }
}

private struct NativeThumbnail: View {
    let value: String
    @State private var data: Data?

    var body: some View {
        Group {
            if let data, let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Color.black.opacity(0.05)
            }
        }
        .task {
            guard data == nil else { return }
            data = await loadData()
        }
    }

    private func loadData() async -> Data? {
        let raw = value
            .replacingOccurrences(of: "asset://localhost/", with: "")
            .removingPercentEncoding ?? value
        let directURL = URL(fileURLWithPath: raw)
        if let data = try? Data(contentsOf: directURL) { return data }
        guard let root = try? FlowixAPI.applicationDataDirectoryURL() else { return nil }
        return try? Data(contentsOf: root.appendingPathComponent(raw))
    }
}

private struct NativeNavigationPage: View {
    let notebooks: [NativeNotebook]
    let tags: [NativeTag]
    let selectedNotebookId: String?
    let selectedTagId: String?
    let cloudState: NativeCloudState?
    let onOpenAccount: () -> Void
    let onClose: () -> Void
    let onSelectNotebook: (String) -> Void
    let onSelectTag: (String?) -> Void
    let onCreateNotebook: () -> Void
    let onRenameNotebook: (NativeNotebook) -> Void
    let onDeleteNotebook: (NativeNotebook) -> Void

    private let columns = [GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        VStack(spacing: 0) {
            navigationTopBar
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    notebookSection
                    tagSection
                }
                .padding(.top, 11)
                .padding(.horizontal, 14)
                .padding(.bottom, 28)
            }
            .scrollIndicators(.hidden)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color.flowixMobileBackground)
        .ignoresSafeArea(edges: .bottom)
    }

    private var navigationTopBar: some View {
        HStack(spacing: 8) {
            Button(action: onOpenAccount) {
                HStack(spacing: 10) {
                    Image(systemName: cloudState?.authenticated == true ? "person.crop.circle.fill" : "person.crop.circle")
                        .font(.system(size: 24, weight: .medium))
                        .foregroundStyle(Color.flowixMobileBrand)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(accountName)
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(Color.flowixMobileForeground)
                            .lineLimit(1)
                        Text(accountSubtitle)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Color.flowixMobileMutedForeground)
                            .lineLimit(1)
                    }
                }
                .padding(.horizontal, 10)
                .frame(minHeight: 48, alignment: .leading)
                .contentShape(RoundedRectangle(cornerRadius: 13))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(cloudState?.authenticated == true ? "账号：\(accountName)，\(accountSubtitle)" : "未登录，点击登录并云同步")

            Spacer(minLength: 0)

            Button {
                withAnimation(.easeInOut(duration: 0.28), onClose)
            } label: {
                Image(systemName: "chevron.right")
                    .font(.system(size: 18, weight: .medium))
                    .frame(width: 48, height: 48)
                    .foregroundStyle(Color.flowixAccent)
                    .background(Color.white, in: Circle())
                    .shadow(color: .black.opacity(0.05), radius: 8, y: 3)
            }
            .accessibilityLabel("返回笔记列表")
        }
        .padding(.horizontal, 9)
        .padding(.top, 5)
        .padding(.bottom, 5)
        .background(Color.flowixMobileBackground.opacity(0.96))
    }

    private var accountName: String {
        guard cloudState?.authenticated == true else { return "未登录" }
        let displayName = cloudState?.account?.user.displayName.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return displayName.isEmpty ? (cloudState?.account?.user.email ?? "Flowix 账号") : displayName
    }

    private var accountSubtitle: String {
        guard cloudState?.authenticated == true else { return "点击登录并云同步" }
        let membership = cloudState?.membership
        return "\(formatStorage(membership?.usedBytes)) / \(formatStorage(membership?.quotaBytes))"
    }

    private func formatStorage(_ bytes: Int64?) -> String {
        guard let bytes, bytes > 0 else { return "0MB" }
        let megabytes = Double(bytes) / (1024 * 1024)
        if megabytes < 10 { return String(format: "%.1f MB", megabytes) }
        return "\(Int(megabytes.rounded())) MB"
    }

    private var notebookSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("笔记本")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.flowixMobileMutedForeground)
                Spacer()
                Button(action: onCreateNotebook) {
                    Image(systemName: "plus")
                        .font(.system(size: 16, weight: .semibold))
                        .frame(width: 40, height: 40)
                        .foregroundStyle(Color.flowixMobileMutedForeground)
                }
                .accessibilityLabel("新建笔记本")
            }
            .padding(.horizontal, 10)
            .frame(minHeight: 44)

            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(notebooks) { notebook in
                    ZStack(alignment: .topTrailing) {
                        Button { onSelectNotebook(notebook.id) } label: {
                            VStack(alignment: .leading, spacing: 12) {
                                HStack {
                                    NativeNotebookIcon(
                                        icon: notebook.icon,
                                        name: notebook.name,
                                        isSelected: notebook.id == selectedNotebookId
                                    )
                                    .frame(width: 34, height: 34)
                                    .background(Color.flowixMobileMuted, in: RoundedRectangle(cornerRadius: 10))
                                    Spacer()
                                }
                                VStack(alignment: .leading, spacing: 3) {
                                    // WebView: 15px / 650 / 1.25 line height.
                                    Text(notebook.name)
                                        .font(.system(size: 15, weight: .semibold))
                                        .lineLimit(1)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                    // WebView: 12px / 500 / 1.2 line height.
                                    Text(String(notebook.memoCount) + " 篇")
                                        .font(.system(size: 12, weight: .medium))
                                        .foregroundStyle(Color.flowixMobileMutedForeground)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                            .frame(maxWidth: .infinity, minHeight: 116, alignment: .topLeading)
                            .padding(.top, 13)
                            .padding(.horizontal, 12)
                            .padding(.bottom, 12)
                            .background(
                                notebook.id == selectedNotebookId
                                    ? Color.flowixMobileBrand.opacity(0.09)
                                    : Color.flowixMobileNotebookCard,
                                in: RoundedRectangle(cornerRadius: 16)
                            )
                            .overlay {
                                RoundedRectangle(cornerRadius: 16)
                                    .stroke(
                                        notebook.id == selectedNotebookId
                                            ? Color.flowixMobileBrand.opacity(0.24)
                                            : Color.flowixMobileHairline,
                                        lineWidth: 1
                                    )
                            }
                        }
                        .buttonStyle(.plain)

                        Menu {
                            Button {
                                onRenameNotebook(notebook)
                            } label: {
                                Label("编辑笔记本", systemImage: "pencil")
                            }
                            Button(role: .destructive) {
                                onDeleteNotebook(notebook)
                            } label: {
                                Label("删除", systemImage: "trash")
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                                .font(.system(size: 18, weight: .medium))
                                .frame(width: 40, height: 40)
                                .foregroundStyle(Color.flowixMobileMutedForeground.opacity(0.33))
                        }
                        .menuStyle(.borderlessButton)
                        .padding(.top, 7)
                        .padding(.trailing, 6)
                    }
                }
            }
        }
    }

    private var tagSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("标签")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color.flowixMobileMutedForeground)
                .padding(.horizontal, 10)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            tagButton(title: "全部", icon: "square.grid.2x2", selected: selectedTagId == nil) {
                onSelectTag(nil)
            }
            ForEach(tags) { tag in
                tagButton(
                    title: tag.name.split(separator: "/").last.map(String.init) ?? tag.name,
                    icon: "number",
                    selected: tag.id == selectedTagId
                ) {
                    onSelectTag(tag.id)
                }
                .padding(.leading, CGFloat(min(3, tag.name.split(separator: "/").count - 1) * 14))
            }
        }
    }

    private func tagButton(
        title: String,
        icon: String,
        selected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    // WebView .mobile-nav-icon uses a 14px / 500 glyph.
                    .font(.system(size: 14, weight: .medium))
                    .frame(width: 28, height: 28)
                    .background(
                        selected ? Color.flowixMobileBrand.opacity(0.14) : Color.flowixMobileMuted,
                        in: RoundedRectangle(cornerRadius: 9)
                    )
                Text(title)
                    // WebView drawer rows use 17px / 500 text.
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(selected ? Color.flowixMobileForeground : Color.flowixForeground)
                    .lineLimit(1)
                Spacer()
            }
            .padding(.horizontal, 12)
            .frame(height: 44)
            .background(selected ? Color.flowixMobileMuted : .clear, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
    }
}
