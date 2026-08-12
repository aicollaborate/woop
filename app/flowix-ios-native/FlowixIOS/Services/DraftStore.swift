import Foundation

enum DraftStore {
    private static let fileManager = FileManager.default

    static func read(memoID: String) throws -> String? {
        let url = try draftURL(memoID: memoID)
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        return try String(contentsOf: url, encoding: .utf8)
    }

    static func write(_ content: String, memoID: String) throws {
        let directory = try draftsDirectory()
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(fileName(for: memoID), isDirectory: false)
        let temporary = url.appendingPathExtension("tmp")
        try content.write(to: temporary, atomically: true, encoding: .utf8)
        if fileManager.fileExists(atPath: url.path) {
            _ = try fileManager.replaceItemAt(url, withItemAt: temporary)
        } else {
            try fileManager.moveItem(at: temporary, to: url)
        }
    }

    static func remove(memoID: String) throws {
        let url = try draftURL(memoID: memoID)
        guard fileManager.fileExists(atPath: url.path) else { return }
        try fileManager.removeItem(at: url)
    }

    private static func draftsDirectory() throws -> URL {
        try FlowixAPI.applicationDataDirectoryURL().appendingPathComponent("drafts", isDirectory: true)
    }

    private static func draftURL(memoID: String) throws -> URL {
        try draftsDirectory().appendingPathComponent(fileName(for: memoID), isDirectory: false)
    }

    private static func fileName(for memoID: String) -> String {
        let safe = memoID.map { character in
            character.isLetter || character.isNumber || character == "-" || character == "_" ? character : "_"
        }
        return String(safe) + ".md"
    }
}
