import Foundation

private enum FlowixNativeFFI {
    @_silgen_name("flowix_native_initialize")
    static func initialize(_ dataDirectory: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_library_snapshot")
    static func librarySnapshot() -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_open_memo")
    static func openMemo(_ memoID: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_write_document")
    static func writeDocument(
        _ memoID: UnsafePointer<CChar>,
        _ content: UnsafePointer<CChar>,
        _ expectedContent: UnsafePointer<CChar>?
    ) -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_set_current_notebook")
    static func setCurrentNotebook(_ notebookID: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_create_notebook")
    static func createNotebook(_ name: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_rename_notebook")
    static func renameNotebook(_ notebookID: UnsafePointer<CChar>, _ name: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_delete_notebook")
    static func deleteNotebook(_ notebookID: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_create_memo")
    static func createMemo(
        _ notebookID: UnsafePointer<CChar>,
        _ title: UnsafePointer<CChar>,
        _ content: UnsafePointer<CChar>
    ) -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_delete_memo")
    static func deleteMemo(_ memoID: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_set_memo_favorited")
    static func setMemoFavorited(_ memoID: UnsafePointer<CChar>, _ favorited: Bool) -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_begin_attachment_upload")
    static func beginAttachmentUpload(
        _ fileName: UnsafePointer<CChar>,
        _ mimeType: UnsafePointer<CChar>,
        _ sizeBytes: UInt64,
        _ memoID: UnsafePointer<CChar>
    ) -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_write_attachment_chunk")
    static func writeAttachmentChunk(
        _ uploadID: UnsafePointer<CChar>,
        _ content: UnsafePointer<CChar>
    ) -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_finish_attachment_upload")
    static func finishAttachmentUpload(_ uploadID: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_cancel_attachment_upload")
    static func cancelAttachmentUpload(_ uploadID: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_cloud_state")
    static func cloudState() -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_cloud_login")
    static func cloudLogin(_ email: UnsafePointer<CChar>, _ password: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_cloud_restore")
    static func cloudRestore(_ refreshToken: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_cloud_logout")
    static func cloudLogout() -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_cloud_list_notebooks")
    static func cloudListNotebooks() -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_cloud_refresh_membership")
    static func cloudRefreshMembership() -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_cloud_sync_now")
    static func cloudSyncNow() -> UnsafeMutablePointer<CChar>?

    @_silgen_name("flowix_native_free_string")
    static func freeString(_ value: UnsafeMutablePointer<CChar>?)
}

struct NativeLibrarySnapshot: Decodable {
    let notebooks: [NativeNotebook]
    let selectedNotebookId: String?
    let tags: [NativeTag]
    let memos: [NativeMemo]
}

struct NativeTag: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
}

struct NativeNotebook: Decodable, Identifiable {
    let id: String
    let name: String
    let icon: String
    let memoCount: Int
}

struct NativeMemo: Decodable, Identifiable {
    let id: String
    let filename: String
    let preview: String
    let createdAt: Int64
    let updatedAt: Int64
    let favorited: Bool
    let thumbnail: String?
    let tags: [String]

    var title: String {
        filename.hasSuffix(".md") ? String(filename.dropLast(3)) : filename
    }
}

struct NativeOpenMemo: Decodable {
    let memo: NativeMemo
    let content: String
}

struct NativeWriteResult: Decodable {
    let id: String
    let content: String
}

struct NativeCreateMemoResult: Decodable {
    let memo: NativeMemo
    let content: String
}

struct NativeCloudState: Decodable {
    let enabled: Bool
    let authenticated: Bool
    let account: NativeCloudAccount?
    let membership: NativeCloudMembership?
    let lastError: String?
}

struct NativeCloudAccount: Decodable {
    let user: NativeCloudUser
    let protocolEpoch: Int
}

struct NativeCloudUser: Decodable {
    let id: String
    let email: String
    let displayName: String
    let systemRole: String
}

struct NativeCloudMembership: Decodable {
    let active: Bool
    let startsAt: Int64?
    let expiresAt: Int64?
    let quotaBytes: Int64
    let usedBytes: Int64
    let availableBytes: Int64?
    let noteCount: Int64?
    let readOnly: Bool
}

struct NativeCloudNotebook: Decodable, Identifiable {
    let id: String
    let name: String
    let icon: String?
    let sortOrder: Int64?
    let createdAt: Int64?
    let updatedAt: Int64?
    let synced: Bool
    let usedBytes: Int64
}

struct NativeCloudAuth: Decodable {
    let state: NativeCloudState
    let refreshToken: String
}

struct NativeCloudSyncResult: Decodable {
    let notebooks: Int
    let uploaded: Int
    let deleted: Int
    let downloaded: Int
    let conflicts: Int
}

enum FlowixAPIError: LocalizedError {
    case native(String)
    case invalidResponse
    case conflict

    var errorDescription: String? {
        switch self {
        case .native(let message): return message
        case .invalidResponse: return "原生接口返回了无效数据。"
        case .conflict: return "笔记已被其他设备修改。"
        }
    }
}

final class FlowixAPI {
    static let shared = FlowixAPI()

    private let decoder = JSONDecoder()
    private let queue = DispatchQueue(label: "com.flowix.native-api", qos: .userInitiated)

    private init() {}

    static func applicationDataDirectoryURL() throws -> URL {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw FlowixAPIError.native("无法找到应用数据目录。")
        }
        return base.appendingPathComponent("Flowix", isDirectory: true)
    }

    func initialize() throws {
        let directory = try applicationDataDirectory()
        let result = try call { _ in
            directory.withCString { FlowixNativeFFI.initialize($0) }
        }
        try validate(result)
    }

    func cloudState() throws -> NativeCloudState {
        let result = try call { _ in FlowixNativeFFI.cloudState() }
        try validate(result)
        guard let state = result["state"] else { throw FlowixAPIError.invalidResponse }
        let data = try JSONSerialization.data(withJSONObject: state)
        return try decoder.decode(NativeCloudState.self, from: data)
    }

    func cloudLogin(email: String, password: String) throws -> NativeCloudState {
        let result = try call { _ in
            email.withCString { emailPointer in
                password.withCString { passwordPointer in FlowixNativeFFI.cloudLogin(emailPointer, passwordPointer) }
            }
        }
        try validate(result)
        let data = try JSONSerialization.data(withJSONObject: result)
        let auth = try decoder.decode(NativeCloudAuth.self, from: data)
        try FlowixKeychain.saveRefreshToken(auth.refreshToken)
        return auth.state
    }

    func restoreCloud(refreshToken: String) throws -> NativeCloudState {
        let result = try call { _ in refreshToken.withCString { FlowixNativeFFI.cloudRestore($0) } }
        try validate(result)
        let data = try JSONSerialization.data(withJSONObject: result)
        let auth = try decoder.decode(NativeCloudAuth.self, from: data)
        try FlowixKeychain.saveRefreshToken(auth.refreshToken)
        return auth.state
    }

    func cloudLogout() throws -> NativeCloudState {
        let result = try call { _ in FlowixNativeFFI.cloudLogout() }
        try validate(result)
        FlowixKeychain.deleteRefreshToken()
        guard let state = result["state"] else { throw FlowixAPIError.invalidResponse }
        let data = try JSONSerialization.data(withJSONObject: state)
        return try decoder.decode(NativeCloudState.self, from: data)
    }

    func cloudListNotebooks() throws -> [NativeCloudNotebook] {
        let result = try call { _ in FlowixNativeFFI.cloudListNotebooks() }
        try validate(result)
        guard let notebooks = result["notebooks"] else { throw FlowixAPIError.invalidResponse }
        let data = try JSONSerialization.data(withJSONObject: notebooks)
        return try decoder.decode([NativeCloudNotebook].self, from: data)
    }

    func cloudRefreshMembership() throws -> NativeCloudState {
        let result = try call { _ in FlowixNativeFFI.cloudRefreshMembership() }
        try validate(result)
        guard let state = result["state"] else { throw FlowixAPIError.invalidResponse }
        let data = try JSONSerialization.data(withJSONObject: state)
        return try decoder.decode(NativeCloudState.self, from: data)
    }

    func cloudSyncNow() throws -> NativeCloudSyncResult {
        let result = try call { _ in FlowixNativeFFI.cloudSyncNow() }
        try validate(result)
        let data = try JSONSerialization.data(withJSONObject: result)
        return try decoder.decode(NativeCloudSyncResult.self, from: data)
    }

    func librarySnapshot() throws -> NativeLibrarySnapshot {
        let result = try call { _ in FlowixNativeFFI.librarySnapshot() }
        try validate(result)
        guard let snapshot = result["snapshot"] else { throw FlowixAPIError.invalidResponse }
        let data = try JSONSerialization.data(withJSONObject: snapshot)
        return try decoder.decode(NativeLibrarySnapshot.self, from: data)
    }

    func openMemo(id: String) throws -> NativeOpenMemo {
        let result = try call { _ in
            id.withCString { FlowixNativeFFI.openMemo($0) }
        }
        try validate(result)
        let data = try JSONSerialization.data(withJSONObject: result)
        return try decoder.decode(NativeOpenMemo.self, from: data)
    }

    func writeDocument(id: String, content: String, expectedContent: String?) throws -> NativeWriteResult {
        let result = try call { _ in
            id.withCString { memoPointer in
                content.withCString { contentPointer in
                    if let expectedContent {
                        return expectedContent.withCString {
                            FlowixNativeFFI.writeDocument(memoPointer, contentPointer, $0)
                        }
                    }
                    return FlowixNativeFFI.writeDocument(memoPointer, contentPointer, nil)
                }
            }
        }
        try validate(result)
        let data = try JSONSerialization.data(withJSONObject: result)
        return try decoder.decode(NativeWriteResult.self, from: data)
    }

    func setCurrentNotebook(id: String?) throws {
        let result = try call { _ in
            if let id {
                return id.withCString { FlowixNativeFFI.setCurrentNotebook($0) }
            }
            return FlowixNativeFFI.setCurrentNotebook(nil)
        }
        try validate(result)
    }

    func createNotebook(name: String) throws {
        let result = try call { _ in name.withCString { FlowixNativeFFI.createNotebook($0) } }
        try validate(result)
    }

    func renameNotebook(id: String, name: String) throws {
        let result = try call { _ in
            id.withCString { notebookPointer in name.withCString { FlowixNativeFFI.renameNotebook(notebookPointer, $0) } }
        }
        try validate(result)
    }

    func deleteNotebook(id: String) throws {
        let result = try call { _ in id.withCString { FlowixNativeFFI.deleteNotebook($0) } }
        try validate(result)
    }

    func createMemo(notebookID: String, title: String, content: String) throws -> NativeCreateMemoResult {
        let result = try call { _ in
            notebookID.withCString { notebookPointer in
                title.withCString { titlePointer in
                    content.withCString { contentPointer in
                        FlowixNativeFFI.createMemo(notebookPointer, titlePointer, contentPointer)
                    }
                }
            }
        }
        try validate(result)
        let data = try JSONSerialization.data(withJSONObject: result)
        return try decoder.decode(NativeCreateMemoResult.self, from: data)
    }

    func deleteMemo(id: String) throws -> Bool {
        let result = try call { _ in id.withCString { FlowixNativeFFI.deleteMemo($0) } }
        try validate(result)
        return result["deleted"] as? Bool ?? false
    }

    func setMemoFavorited(id: String, favorited: Bool) throws {
        let result = try call { _ in
            id.withCString { FlowixNativeFFI.setMemoFavorited($0, favorited) }
        }
        try validate(result)
    }

    func beginAttachmentUpload(fileName: String, mimeType: String, sizeBytes: UInt64, memoID: String) throws -> String {
        let result = try call { _ in
            fileName.withCString { fileNamePointer in
                mimeType.withCString { mimeTypePointer in
                    memoID.withCString { memoPointer in
                        FlowixNativeFFI.beginAttachmentUpload(fileNamePointer, mimeTypePointer, sizeBytes, memoPointer)
                    }
                }
            }
        }
        try validate(result)
        guard let uploadID = result["uploadId"] as? String else { throw FlowixAPIError.invalidResponse }
        return uploadID
    }

    func writeAttachmentChunk(uploadID: String, content: String) throws {
        let result = try call { _ in
            uploadID.withCString { uploadPointer in
                content.withCString { contentPointer in
                    FlowixNativeFFI.writeAttachmentChunk(uploadPointer, contentPointer)
                }
            }
        }
        try validate(result)
    }

    func finishAttachmentUpload(uploadID: String) throws -> String {
        let result = try call { _ in
            uploadID.withCString { FlowixNativeFFI.finishAttachmentUpload($0) }
        }
        try validate(result)
        guard let storageKey = result["storageKey"] as? String else { throw FlowixAPIError.invalidResponse }
        return storageKey
    }

    func cancelAttachmentUpload(uploadID: String) throws {
        let result = try call { _ in
            uploadID.withCString { FlowixNativeFFI.cancelAttachmentUpload($0) }
        }
        try validate(result)
    }

    // The C ABI performs file and SQLite I/O synchronously. Keep that detail
    // behind one serial worker queue so SwiftUI never blocks the main thread
    // and two mutations cannot interleave inside the Rust store.
    func initializeAsync() async throws {
        try await perform { try self.initialize() }
        if let token = FlowixKeychain.refreshToken {
            _ = try? await perform { try self.restoreCloud(refreshToken: token) }
        }
    }

    func librarySnapshotAsync() async throws -> NativeLibrarySnapshot {
        try await perform { try self.librarySnapshot() }
    }

    func setCurrentNotebookAsync(id: String?) async throws {
        try await perform { try self.setCurrentNotebook(id: id) }
    }

    func cloudStateAsync() async throws -> NativeCloudState {
        try await perform { try self.cloudState() }
    }

    func cloudLoginAsync(email: String, password: String) async throws -> NativeCloudState {
        try await perform { try self.cloudLogin(email: email, password: password) }
    }

    func cloudLogoutAsync() async throws -> NativeCloudState {
        try await perform { try self.cloudLogout() }
    }

    func cloudListNotebooksAsync() async throws -> [NativeCloudNotebook] {
        try await perform { try self.cloudListNotebooks() }
    }

    func cloudRefreshMembershipAsync() async throws -> NativeCloudState {
        try await perform { try self.cloudRefreshMembership() }
    }

    func cloudSyncNowAsync() async throws -> NativeCloudSyncResult {
        try await perform { try self.cloudSyncNow() }
    }

    func createNotebookAsync(name: String) async throws {
        try await perform { try self.createNotebook(name: name) }
    }

    func renameNotebookAsync(id: String, name: String) async throws {
        try await perform { try self.renameNotebook(id: id, name: name) }
    }

    func deleteNotebookAsync(id: String) async throws {
        try await perform { try self.deleteNotebook(id: id) }
    }

    func createMemoAsync(notebookID: String, title: String, content: String) async throws -> NativeCreateMemoResult {
        try await perform { try self.createMemo(notebookID: notebookID, title: title, content: content) }
    }

    func openMemoAsync(id: String) async throws -> NativeOpenMemo {
        try await perform { try self.openMemo(id: id) }
    }

    func writeDocumentAsync(id: String, content: String, expectedContent: String?) async throws -> NativeWriteResult {
        try await perform {
            try self.writeDocument(id: id, content: content, expectedContent: expectedContent)
        }
    }

    func deleteMemoAsync(id: String) async throws -> Bool {
        try await perform { try self.deleteMemo(id: id) }
    }

    func setMemoFavoritedAsync(id: String, favorited: Bool) async throws {
        try await perform { try self.setMemoFavorited(id: id, favorited: favorited) }
    }

    func beginAttachmentUploadAsync(fileName: String, mimeType: String, sizeBytes: UInt64, memoID: String) async throws -> String {
        try await perform {
            try self.beginAttachmentUpload(fileName: fileName, mimeType: mimeType, sizeBytes: sizeBytes, memoID: memoID)
        }
    }

    func writeAttachmentChunkAsync(uploadID: String, content: String) async throws {
        try await perform { try self.writeAttachmentChunk(uploadID: uploadID, content: content) }
    }

    func finishAttachmentUploadAsync(uploadID: String) async throws -> String {
        try await perform { try self.finishAttachmentUpload(uploadID: uploadID) }
    }

    func cancelAttachmentUploadAsync(uploadID: String) async throws {
        try await perform { try self.cancelAttachmentUpload(uploadID: uploadID) }
    }

    private func applicationDataDirectory() throws -> String {
        let directory = try Self.applicationDataDirectoryURL()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.path
    }

    private func call(
        _ operation: (UnsafeMutablePointer<CChar>?) -> UnsafeMutablePointer<CChar>?
    ) throws -> [String: Any] {
        let pointer = operation(nil)
        guard let pointer else { throw FlowixAPIError.invalidResponse }
        defer { FlowixNativeFFI.freeString(pointer) }
        let data = Data(String(cString: pointer).utf8)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw FlowixAPIError.invalidResponse
        }
        return json
    }

    private func perform<T>(_ operation: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    continuation.resume(returning: try operation())
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private func validate(_ result: [String: Any]) throws {
        guard let ok = result["ok"] as? Bool else { throw FlowixAPIError.invalidResponse }
        if ok { return }
        if result["error"] as? String == "CONFLICT" { throw FlowixAPIError.conflict }
        throw FlowixAPIError.native(result["error"] as? String ?? "原生接口调用失败。")
    }
}
