// Runs AmeekAi's tool calls in the browser. The AI service only plans; every file it
// reads or changes goes through features/file.js, the same layer the Explorer uses, so
// it works the same for cloud projects and folders on the user's device.
import { createFile, createFolder, deleteFile, getTree, updateFile } from './file'
import { getLanguage } from '../utils/language'
import { Shell } from '../utils/shell'

// Big results cost tokens and time; the model rarely needs more than this at once
const MAX_RESULT_CHARS = 100_000
const MAX_LIST_LINES = 2000
const MAX_SEARCH_MATCHES = 200
const COMMAND_TIMEOUT_MS = 30_000
// Shown as folders but never expanded, like the tree itself
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage', '.venv', '__pycache__'])

class ToolError extends Error {}

const isFolder = (node) => node?.type === 'folder'
const byName = (a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : isFolder(a) ? -1 : 1)
const formatSize = (chars) => (chars < 1024 ? `${chars} B` : `${(chars / 1024).toFixed(1)} KB`)
const clip = (text) => (text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n… [cut: ${text.length - MAX_RESULT_CHARS} more characters]`
    : text)
const lineCount = (text) => (text ? text.split('\n').length : 0)

// Swaps in unsaved editor text, so the AI sees files as the user sees them, saved or not
const withDrafts = (nodes, drafts) => nodes.map((node) => {
    if (isFolder(node)) return { ...node, children: withDrafts(node.children || [], drafts) }
    const draft = drafts[node._id]
    return draft === undefined || node.skipped ? node : { ...node, content: draft, size: draft.length }
})

// onChange({ path, fileId, name, before, after }) reports every file the AI changes, for
// review and undo. before is null for a new file, after is null for a deleted one.
// getDrafts() returns unsaved editor content by file id.
export const createToolRunner = ({ projectId, onChange, getDrafts }) => {
    let tree = null
    const report = (change) => onChange?.(change)

    const load = async () => {
        tree ??= withDrafts((await getTree(projectId)) || [], getDrafts?.() || {})
        return tree
    }
    // Every change reloads the tree before the next lookup, so paths stay current
    const invalidate = () => {
        tree = null
    }

    // The single top folder is the project root, as in the Explorer and terminal
    const root = () => (tree.length === 1 && isFolder(tree[0])
        ? tree[0]
        : { _id: null, name: '', type: 'folder', children: tree })

    const split = (path) => {
        const parts = String(path ?? '.').replace(/\\/g, '/').split('/').filter(part => part && part !== '.')
        if (parts.includes('..')) throw new ToolError('Paths cannot leave the project folder')
        // Models sometimes prefix the project folder's own name
        const top = root()
        if (parts[0] === top.name && !top.children?.some(child => child.name === parts[0])) parts.shift()
        return parts
    }

    const lookup = (parts) => {
        let node = root()
        for (const name of parts) {
            node = isFolder(node) ? node.children?.find(child => child.name === name) : null
            if (!node) return null
        }
        return node
    }

    const need = async (path, kind) => {
        await load()
        const node = lookup(split(path))
        if (!node) throw new ToolError(`${path} does not exist`)
        if (kind === 'file' && isFolder(node)) throw new ToolError(`${path} is a folder, not a file`)
        if (kind === 'folder' && !isFolder(node)) throw new ToolError(`${path} is a file, not a folder`)
        return node
    }

    // mkdir -p: returns the folder at `parts`, creating what is missing
    const ensureFolder = async (parts) => {
        await load()
        let node = root()
        if (!node._id) throw new ToolError('This project has no root folder yet')
        for (const name of parts) {
            let child = node.children?.find(c => c.name === name)
            if (child && !isFolder(child)) throw new ToolError(`${name} is a file, not a folder`)
            if (!child) {
                const result = await createFolder({ projectId, name, parentId: node._id })
                if (!result || result.error) throw new ToolError(result?.error || `Could not create folder ${name}`)
                child = { ...result, children: [] }
                node.children = [...(node.children || []), child]
            }
            node = child
        }
        return node
    }

    const walkFiles = (node, prefix, visit) => {
        for (const child of [...(node.children || [])].sort(byName)) {
            const path = prefix ? `${prefix}/${child.name}` : child.name
            if (isFolder(child)) {
                if (!SKIP_DIRS.has(child.name)) walkFiles(child, path, visit)
            } else visit(child, path)
        }
    }

    const tools = {
        async list_files({ path = '.' }) {
            const start = await need(path, 'folder')
            const lines = []
            const walk = (node, prefix, depth) => {
                for (const child of [...(node.children || [])].sort(byName)) {
                    if (lines.length >= MAX_LIST_LINES) return
                    const childPath = prefix ? `${prefix}/${child.name}` : child.name
                    if (isFolder(child)) {
                        const skipped = SKIP_DIRS.has(child.name)
                        lines.push(`${'  '.repeat(depth)}${childPath}/${skipped ? '  (not expanded)' : ''}`)
                        if (!skipped) walk(child, childPath, depth + 1)
                    } else {
                        const note = child.skipped ? `, ${child.skipped} — not readable` : ''
                        lines.push(`${'  '.repeat(depth)}${childPath}  (${formatSize(child.size ?? child.content?.length ?? 0)}${note})`)
                    }
                }
            }
            const prefix = split(path).join('/')
            walk(start, prefix, 0)
            if (!lines.length) return 'The folder is empty.'
            if (lines.length >= MAX_LIST_LINES) lines.push(`… stopped after ${MAX_LIST_LINES} entries`)
            return lines.join('\n')
        },

        async read_file({ path }) {
            const node = await need(path, 'file')
            if (node.skipped) throw new ToolError(`${path} is ${node.skipped} and cannot be read`)
            return node.content ?? ''
        },

        async write_file({ path, content = '' }) {
            await load()
            const parts = split(path)
            if (!parts.length) throw new ToolError('A file path is required')
            const existing = lookup(parts)
            if (isFolder(existing)) throw new ToolError(`${path} is a folder`)
            const clean = parts.join('/')
            if (existing) {
                if (!(await updateFile(existing._id, { name: existing.name, content }))) throw new ToolError(`Could not save ${path}`)
                invalidate()
                report({ path: clean, fileId: existing._id, name: existing.name, before: existing.content ?? '', after: content })
                return `Updated ${path} (${lineCount(content)} lines)`
            }
            const name = parts[parts.length - 1]
            const parent = await ensureFolder(parts.slice(0, -1))
            const result = await createFile({ projectId, name, parentId: parent._id, content, language: getLanguage(name).id })
            invalidate()
            if (!result || result.error) throw new ToolError(result?.error || `Could not create ${path}`)
            report({ path: clean, fileId: result._id, name, before: null, after: content })
            return `Created ${path} (${lineCount(content)} lines)`
        },

        async edit_file({ path, find, replace = '' }) {
            const node = await need(path, 'file')
            if (!find) throw new ToolError('"find" must not be empty')
            const content = node.content ?? ''
            const count = content.split(find).length - 1
            if (count === 0) throw new ToolError(`The text to find is not in ${path}. Read the file again and copy the text exactly.`)
            if (count > 1) throw new ToolError(`The text to find occurs ${count} times in ${path}. Include more surrounding lines so it is unique.`)
            const next = content.replace(find, () => replace)
            const clean = split(path).join('/')
            if (!(await updateFile(node._id, { name: node.name, content: next }))) throw new ToolError(`Could not save ${path}`)
            invalidate()
            report({ path: clean, fileId: node._id, name: node.name, before: content, after: next })
            return `Edited ${path}`
        },

        async create_folder({ path }) {
            await load()
            const parts = split(path)
            if (!parts.length) throw new ToolError('A folder path is required')
            await ensureFolder(parts)
            invalidate()
            return `Created folder ${path}`
        },

        async rename_path({ path, newName }) {
            const node = await need(path)
            if (node === root()) throw new ToolError('The project folder cannot be renamed')
            if (!newName || /[\\/]/.test(newName)) throw new ToolError('newName must be a plain name, not a path')
            if (!(await updateFile(node._id, { name: newName }))) throw new ToolError(`Could not rename ${path}`)
            invalidate()
            return `Renamed ${path} to ${newName}`
        },

        async delete_path({ path }) {
            const node = await need(path)
            if (node === root()) throw new ToolError('The project folder cannot be deleted')
            const prefix = split(path).join('/')
            const removed = []
            if (isFolder(node)) walkFiles(node, prefix, (file, filePath) => removed.push({ file, filePath }))
            else removed.push({ file: node, filePath: prefix })
            if (!(await deleteFile(node._id))) throw new ToolError(`Could not delete ${path}`)
            invalidate()
            for (const { file, filePath } of removed) {
                if (!file.skipped) report({ path: filePath, fileId: file._id, name: file.name, before: file.content ?? '', after: null })
            }
            return `Deleted ${path}`
        },

        async search_files({ query, regex = false }) {
            if (!query) throw new ToolError('query must not be empty')
            let pattern
            try {
                pattern = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
            } catch (error) {
                throw new ToolError(`Invalid regular expression: ${error.message}`)
            }
            await load()
            const matches = []
            walkFiles(root(), '', (file, path) => {
                if (matches.length >= MAX_SEARCH_MATCHES || file.skipped) return
                ;(file.content ?? '').split('\n').forEach((line, index) => {
                    if (matches.length < MAX_SEARCH_MATCHES && pattern.test(line)) matches.push(`${path}:${index + 1}: ${line.trim().slice(0, 200)}`)
                })
            })
            if (!matches.length) return 'No matches.'
            if (matches.length >= MAX_SEARCH_MATCHES) matches.push(`… stopped after ${MAX_SEARCH_MATCHES} matches`)
            return matches.join('\n')
        },

        async run_command({ command }) {
            if (!command?.trim()) throw new ToolError('command must not be empty')
            const shell = new Shell({ projectId, tree: await load(), user: 'ameekai' })
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS)
            let output = ''
            const io = {
                write: (text) => { output += text },
                clear: () => { output = '' },
                exit: () => {},
                openFile: () => {},
                signal: controller.signal,
                user: 'ameekai',
            }
            try {
                if (await shell.run(command, io)) invalidate()
            } finally {
                clearTimeout(timer)
            }
            const timedOut = controller.signal.aborted ? `\n[stopped after ${COMMAND_TIMEOUT_MS / 1000}s]` : ''
            return `${output.trimEnd() || '(no output)'}${timedOut}\n[exit code ${shell.status}]`
        },
    }

    // Runs one call; never throws, since the model should see and fix its own mistakes
    const run = async ({ id, name, args }) => {
        const tool = tools[name]
        if (!tool) return { id, ok: false, output: `Error: unknown tool ${name}` }
        try {
            return { id, ok: true, output: clip(String(await tool(args || {}))) }
        } catch (error) {
            // A failed write may have partly changed the tree
            invalidate()
            return { id, ok: false, output: `Error: ${error instanceof ToolError ? error.message : error?.message || error}` }
        }
    }

    return { run }
}

// Short labels for the chat's list of steps
export const describeToolCall = ({ name, args = {} }) => {
    switch (name) {
        case 'list_files': return { verb: 'Listed', target: args.path && args.path !== '.' ? args.path : 'project files' }
        case 'read_file': return { verb: 'Read', target: args.path }
        case 'write_file': return { verb: 'Wrote', target: args.path }
        case 'edit_file': return { verb: 'Edited', target: args.path }
        case 'create_folder': return { verb: 'Created folder', target: args.path }
        case 'rename_path': return { verb: 'Renamed', target: `${args.path} → ${args.newName}` }
        case 'delete_path': return { verb: 'Deleted', target: args.path }
        case 'search_files': return { verb: 'Searched', target: `"${args.query}"` }
        case 'run_command': return { verb: 'Ran', target: args.command }
        default: return { verb: name, target: '' }
    }
}

// Tools that change files, so the Explorer and open tabs refresh after them
export const CHANGING_TOOLS = new Set(['write_file', 'edit_file', 'create_folder', 'rename_path', 'delete_path', 'run_command'])
