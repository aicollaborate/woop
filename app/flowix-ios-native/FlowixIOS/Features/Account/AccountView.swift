import SwiftUI

@MainActor
struct AccountView: View {
    private enum SyncPhase {
        case idle
        case syncing
        case success
        case error
    }

    private let privacyURL = URL(string: "https://flowix-memo.com/cn/privacy/")!
    private let termsURL = URL(string: "https://flowix-memo.com/cn/terms/")!

    var onClose: (() -> Void)? = nil
    var onHeaderDragChanged: ((CGFloat) -> Void)? = nil
    var onHeaderDragEnded: ((CGFloat, CGFloat) -> Void)? = nil
    @Environment(\.openURL) private var openURL
    @State private var cloudState: NativeCloudState?
    @State private var cloudNotebooks: [NativeCloudNotebook] = []
    @State private var email = ""
    @State private var password = ""
    @State private var isLoading = false
    @State private var isLoadingNotebooks = false
    @State private var isRefreshingMembership = false
    @State private var isSyncing = false
    @State private var syncPhase: SyncPhase = .idle
    @State private var syncMessage: String?
    @State private var errorMessage: String?
    @State private var notebooksError: String?
    @State private var syncError: String?
    @State private var showResetBindingConfirmation = false

    private var authenticated: Bool {
        cloudState?.authenticated == true
    }

    private var syncAvailable: Bool {
        guard let state = cloudState else { return false }
        return state.authenticated
            && state.enabled
            && state.membership?.active == true
            && state.membership?.readOnly != true
    }

    private var isBusy: Bool {
        isLoading || isRefreshingMembership || isSyncing
    }

    var body: some View {
        ZStack(alignment: .top) {
            // Keep the sheet background continuous through the bottom safe area
            // when this view is presented as a full-screen account page.
            Color.flowixMobileBackground.ignoresSafeArea()

            VStack(spacing: 0) {
                header

                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if authenticated {
                            authenticatedContent
                        } else {
                            localModeCard
                            loginCard
                            resetBindingButton
                        }

                        footer
                    }
                    // Keep spacing inside the account sheet. The sheet itself
                    // is responsible for touching the screen edges; removing
                    // this padding made the cards look glued to the bezel.
                    .padding(.horizontal, 18)
                    .padding(.top, 8)
                    .padding(.bottom, 22)
                }
                .scrollIndicators(.hidden)
                .scrollDismissesKeyboard(.interactively)
            }
        }
        .task { await load() }
        .alert("解除设备云账号绑定？", isPresented: $showResetBindingConfirmation) {
            Button("解除绑定", role: .destructive) {
                FlowixKeychain.deleteRefreshToken()
                errorMessage = nil
                Task { await load() }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("这不会删除本地笔记。解除后，下次登录其他账号时会重新建立设备绑定。")
        }
    }

    private var header: some View {
        ZStack {
            Text("账号与云同步")
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(Color.flowixMobileForeground)

            HStack {
                Spacer()
                if let onClose {
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(.system(size: 18, weight: .medium))
                            .foregroundStyle(Color.flowixMobileForeground)
                    }
                    .buttonStyle(NativeCircleButtonStyle())
                    .accessibilityLabel("关闭账号面板")
                }
            }
        }
        .padding(.horizontal, 18)
        .frame(minHeight: 62)
        .zIndex(1)
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 8)
                .onChanged { value in
                    guard value.translation.height > 0 else { return }
                    onHeaderDragChanged?(value.translation.height)
                }
                .onEnded { value in
                    let distance = max(value.translation.height, 0)
                    let predictedDistance = max(value.predictedEndTranslation.height, distance)
                    onHeaderDragEnded?(distance, predictedDistance)
                }
        )
    }

    private var localModeCard: some View {
        HStack(spacing: 12) {
            Image(systemName: "icloud.slash")
                .font(.system(size: 19))
                .frame(width: 34, height: 34)
                .foregroundStyle(Color.flowixMobileMutedForeground)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 11))

            VStack(alignment: .leading, spacing: 3) {
                Text("正在本地使用")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Color.flowixMobileForeground)
                Text("笔记保存在此设备，不会上传。")
                    .font(.system(size: 10))
                    .foregroundStyle(Color.flowixMobileMutedForeground)
            }
            Spacer(minLength: 0)
        }
        .padding(13)
        .background(Color.flowixMobileMuted, in: RoundedRectangle(cornerRadius: 15))
        .overlay {
            RoundedRectangle(cornerRadius: 15)
                .stroke(Color.flowixMobileHairline, lineWidth: 1)
        }
        .padding(.top, 8)
        .padding(.bottom, 6)
    }

    private var loginCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            accountField(label: "邮箱") {
                TextField("邮箱", text: $email)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                    .textContentType(.username)
            }
            accountField(label: "密码") {
                SecureField("密码", text: $password)
                    .textContentType(.password)
            }

            if let errorMessage, !errorMessage.isEmpty {
                Text(errorMessage)
                    .font(.system(size: 12))
                    .foregroundStyle(Color.flowixMobileDestructive)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button {
                Task { await login() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.right.circle")
                        .font(.system(size: 17))
                    Text(isLoading ? "登录中…" : "登录")
                }
                .font(.system(size: 16, weight: .bold))
                .frame(maxWidth: .infinity, minHeight: 48)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.white)
            .background(Color.flowixMobilePrimary, in: RoundedRectangle(cornerRadius: 13))
            .disabled(isBusy || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty)
            .opacity(isBusy || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty ? 0.45 : 1)
        }
        .padding(14)
        .background(Color.white.opacity(0.78), in: RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.flowixMobileHairline, lineWidth: 1)
        }
    }

    private func accountField<Content: View>(
        label: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.flowixMobileForeground)
            content()
                .padding(.horizontal, 14)
                .frame(height: 48)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 13))
                .overlay {
                    RoundedRectangle(cornerRadius: 13)
                        .stroke(Color.flowixMobileHairline, lineWidth: 1)
                }
        }
    }

    private var resetBindingButton: some View {
        Button("解除设备云账号绑定") {
            showResetBindingConfirmation = true
        }
        .buttonStyle(.plain)
        .font(.system(size: 11))
        .foregroundStyle(Color.flowixMobileMutedForeground)
        .underline()
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .disabled(isBusy)
        .opacity(isBusy ? 0.45 : 1)
    }

    private var authenticatedContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            accountSummary
            cloudNotebookSection
        }
        .padding(.top, 12)
    }

    private var accountSummary: some View {
        VStack(alignment: .leading, spacing: 11) {
            infoRow(label: "账号名称", value: accountDisplayName)
            infoRow(label: "订阅状态", value: membershipLabel, valueColor: syncAvailable ? Color.flowixMobileSuccess : Color.flowixMobileForeground)
            infoRow(label: "到期时间", value: formatDate(cloudState?.membership?.expiresAt))
            infoRow(label: "存储使用", value: "(formatBytes(cloudState?.membership?.usedBytes ?? 0)) / (formatBytes(cloudState?.membership?.quotaBytes ?? 0))", icon: "internaldrive")

            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.flowixMobileForeground.opacity(0.10))
                    Capsule()
                        .fill(Color.flowixMobileBrand)
                        .frame(width: proxy.size.width * usageProgress)
                }
            }
            .frame(height: 6)
            .padding(.top, 3)

            Button {
                Task { await logout() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "rectangle.portrait.and.arrow.right")
                        .font(.system(size: 17))
                    Text("退出登录")
                }
                .font(.system(size: 16, weight: .bold))
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.flowixForeground)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .stroke(Color(red: 0.82, green: 0.84, blue: 0.86), lineWidth: 1)
            }
            .disabled(isBusy)
            .opacity(isBusy ? 0.45 : 1)
            .padding(.top, 3)
        }
        .padding(14)
        .background(Color.white.opacity(0.72), in: RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.flowixMobileHairline, lineWidth: 1)
        }
    }

    private func infoRow(
        label: String,
        value: String,
        icon: String? = nil,
        valueColor: Color = Color.flowixMobileForeground
    ) -> some View {
        HStack(spacing: 14) {
            HStack(spacing: 6) {
                if let icon {
                    Image(systemName: icon)
                        .font(.system(size: 15))
                }
                Text(label)
            }
            .font(.system(size: 13))
            .foregroundStyle(Color.flowixMobileMutedForeground)

            Spacer(minLength: 0)
            Text(value)
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(valueColor)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .frame(minHeight: 24)
    }

    private var cloudNotebookSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("云端笔记本")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Color.flowixMobileForeground)
                Spacer()
                Text(String(cloudNotebooks.count))
                    .font(.system(size: 12))
                    .foregroundStyle(Color.flowixMobileMutedForeground)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Color.flowixMobileMuted, in: Capsule())
            }

            if isLoadingNotebooks {
                Text("正在加载笔记本…")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.flowixMobileMutedForeground)
                    .padding(.top, 12)
            } else if cloudNotebooks.isEmpty {
                Text("暂无云端笔记本")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.flowixMobileMutedForeground)
                    .padding(.top, 12)
            } else {
                VStack(spacing: 7) {
                    ForEach(cloudNotebooks) { notebook in
                        cloudNotebookRow(notebook)
                    }
                }
                .padding(.top, 12)
            }

            if let notebooksError, !notebooksError.isEmpty {
                Text(notebooksError)
                    .font(.system(size: 12))
                    .foregroundStyle(Color.flowixMobileDestructive)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 12)
            }

            if let errorMessage, !errorMessage.isEmpty {
                Text(errorMessage)
                    .font(.system(size: 12))
                    .foregroundStyle(Color.flowixMobileDestructive)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 12)
            }

            Text("同步状态")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(Color.flowixMobileMutedForeground)
                .padding(.top, 16)

            Text(syncStatusText)
                .font(.system(size: 13))
                .foregroundStyle(syncStatusColor)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 12)
                .padding(.bottom, 14)

            Button {
                Task { await refreshMembership() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 17, weight: .medium))
                    Text(isRefreshingMembership ? "检查中…" : "重新检查")
                }
                .font(.system(size: 16, weight: .bold))
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.flowixForeground)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .stroke(Color(red: 0.82, green: 0.84, blue: 0.86), lineWidth: 1)
            }
            .disabled(isBusy)
            .opacity(isBusy ? 0.45 : 1)
        }
        .padding(14)
        .background(Color.white.opacity(0.72), in: RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.flowixMobileHairline, lineWidth: 1)
        }
    }

    private func cloudNotebookRow(_ notebook: NativeCloudNotebook) -> some View {
        HStack(spacing: 9) {
            Image(systemName: "book.closed")
                .font(.system(size: 16))
                .frame(width: 28, height: 28)
                .foregroundStyle(Color.flowixMobileMutedForeground)
                .background(Color.flowixMobileMuted, in: RoundedRectangle(cornerRadius: 9))

            Text(notebook.name)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.flowixMobileForeground)
                .lineLimit(1)

            Spacer(minLength: 0)
            Text(formatBytes(notebook.usedBytes))
                .font(.system(size: 12))
                .foregroundStyle(Color.flowixMobileMutedForeground)
                .lineLimit(1)

            Text(notebookStatus(notebook))
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(notebook.synced ? Color.flowixMobileSuccess : Color.flowixMobileMutedForeground)
                .padding(.horizontal, notebook.synced ? 7 : 0)
                .padding(.vertical, notebook.synced ? 3 : 0)
                .background(notebook.synced ? Color.flowixMobileSuccess.opacity(0.12) : .clear, in: Capsule())
        }
        .frame(minHeight: 38)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 7) {
            footerRow(label: "语言", value: "简体中文")
            Button {
                openURL(privacyURL)
            } label: {
                footerRow(label: "隐私协议", value: "查看")
            }
            .buttonStyle(.plain)
            Button {
                openURL(termsURL)
            } label: {
                footerRow(label: "服务说明", value: "Terms")
            }
            .buttonStyle(.plain)
            Text("Flowix Memo v\(appVersion)")
                .font(.system(size: 11))
                .foregroundStyle(Color.flowixMobileMutedForeground.opacity(0.82))
                .padding(.top, 1)
        }
        .font(.system(size: 12))
        .padding(.top, 8)
    }

    private func footerRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.flowixMobileForeground)
            Spacer(minLength: 16)
            Text(value)
                .font(.system(size: 14))
                .foregroundStyle(Color.flowixMobileMutedForeground)
                .lineLimit(1)
        }
        .frame(height: 48)
        .contentShape(Rectangle())
    }

    private var accountDisplayName: String {
        let name = cloudState?.account?.user.displayName.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? (cloudState?.account?.user.email ?? "Flowix 账号") : name
    }

    private var membershipLabel: String {
        if cloudState?.membership?.active == true { return "订阅有效" }
        if cloudState?.membership?.readOnly == true { return "已到期（只读）" }
        return "未开通订阅"
    }

    private var usageProgress: CGFloat {
        guard let membership = cloudState?.membership, membership.quotaBytes > 0 else { return 0 }
        return min(1, max(0, CGFloat(membership.usedBytes) / CGFloat(membership.quotaBytes)))
    }

    private var syncStatusText: String {
        if let syncError, !syncError.isEmpty { return syncError }
        if !syncAvailable {
            if cloudState?.membership?.readOnly == true { return "订阅已到期，云端内容暂时仅可查看。" }
            if cloudState?.membership?.active != true { return "开通有效订阅后，笔记会自动同步。" }
            return "正在准备云同步…"
        }
        if isSyncing { return "正在同步笔记…" }
        if let syncMessage { return syncMessage }
        return "云同步已开启，等待同步。"
    }

    private var syncStatusColor: Color {
        if syncError != nil || syncPhase == .error { return Color.flowixMobileDestructive }
        if !syncAvailable { return Color(red: 0.62, green: 0.48, blue: 0.20) }
        if syncPhase == .success { return Color.flowixMobileSuccess }
        return Color.flowixMobileMutedForeground
    }

    private var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.2.0"
    }

    private func notebookStatus(_ notebook: NativeCloudNotebook) -> String {
        if notebook.synced { return "已同步" }
        if !syncAvailable {
            return cloudState?.membership?.readOnly == true ? "只读" : "未开启"
        }
        if isSyncing { return "同步中" }
        if syncPhase == .error { return "同步失败" }
        return "待同步"
    }

    private func formatBytes(_ bytes: Int64) -> String {
        guard bytes > 0 else { return "0 B" }
        let units = ["B", "KB", "MB", "GB"]
        var amount = Double(bytes)
        var unit = 0
        while amount >= 1024 && unit < units.count - 1 {
            amount /= 1024
            unit += 1
        }
        let value = amount >= 10 || unit == 0 ? String(Int(amount.rounded())) : String(format: "%.1f", amount)
        return "\(value) \(units[unit])"
    }

    private func formatDate(_ milliseconds: Int64?) -> String {
        guard let milliseconds else { return "未设置" }
        return Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1_000)
            .formatted(.dateTime.year().month().day())
    }

    private func load() async {
        do {
            cloudState = try await FlowixAPI.shared.cloudStateAsync()
            if authenticated { await loadCloudNotebooks() }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadCloudNotebooks() async {
        guard authenticated else {
            cloudNotebooks = []
            return
        }
        isLoadingNotebooks = true
        do {
            cloudNotebooks = try await FlowixAPI.shared.cloudListNotebooksAsync()
            notebooksError = nil
        } catch {
            notebooksError = "无法加载云端笔记本：\(error.localizedDescription)"
        }
        isLoadingNotebooks = false
    }

    private func login() async {
        isLoading = true
        errorMessage = nil
        syncError = nil
        syncMessage = nil
        syncPhase = .idle
        do {
            cloudState = try await FlowixAPI.shared.cloudLoginAsync(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password)
            password = ""
            await loadCloudNotebooks()
            if syncAvailable { await syncNow() }
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func logout() async {
        isLoading = true
        do {
            cloudState = try await FlowixAPI.shared.cloudLogoutAsync()
            cloudNotebooks = []
            syncMessage = nil
            syncError = nil
            syncPhase = .idle
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func refreshMembership() async {
        isRefreshingMembership = true
        errorMessage = nil
        syncError = nil
        do {
            cloudState = try await FlowixAPI.shared.cloudRefreshMembershipAsync()
            await loadCloudNotebooks()
            if syncAvailable { await syncNow() }
        } catch {
            errorMessage = error.localizedDescription
        }
        isRefreshingMembership = false
    }

    private func syncNow() async {
        guard syncAvailable else { return }
        isSyncing = true
        syncPhase = .syncing
        syncError = nil
        do {
            let result = try await FlowixAPI.shared.cloudSyncNowAsync()
            cloudState = try? await FlowixAPI.shared.cloudStateAsync()
            syncMessage = "最近同步完成：上传 \(result.uploaded)，下载 \(result.downloaded)"
            syncPhase = .success
            await loadCloudNotebooks()
        } catch {
            syncError = "同步失败：\(error.localizedDescription)"
            syncPhase = .error
        }
        isSyncing = false
    }
}
