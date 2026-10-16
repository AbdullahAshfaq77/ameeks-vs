import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertCircle, ArrowUp, Bug, Check, ChevronDown, FileText, FlaskConical, History, Image as ImageIcon, MessageSquarePlus, Paperclip, Redo2, RotateCcw, Sparkles, Square, Trash2, Undo2, X } from 'lucide-react'
import Markdown from './Markdown'
import { getAmeekAiImage, prepareAmeekAiImage, runAmeekAi, uploadAmeekAiImage } from '../features/ai'
import { CHANGING_TOOLS, createToolRunner, describeToolCall } from '../features/aiTools'
import { countLineChanges } from '../utils/lineDiff'

const MAX_LINES = 5
const LINE_HEIGHT = 20
const TEXTAREA_PADDING = 16
const MAX_TEXTAREA = MAX_LINES * LINE_HEIGHT + TEXTAREA_PADDING
const MAX_ATTACHMENTS = 5
const MAX_ATTACHMENT_BYTES = 64 * 1024

const QUICK_ACTIONS = [
    { icon: Sparkles, label: 'Explain code', prompt: 'Explain what the code in this file does, step by step.' },
    { icon: Bug, label: 'Fix bugs', prompt: 'Review this project for bugs and tell me how to fix them.' },
    { icon: FlaskConical, label: 'Write a test', prompt: 'Write a unit test for the code I am working on.' },
]

// Before chats had history, one conversation per project was stored under this key
const legacyKey = (projectId) => `ameekai:chat:${projectId || 'workspace'}`
const chatsKey = (projectId) => `ameekai:chats:${projectId || 'workspace'}`
const MAX_CHATS = 30

const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const createChat = (messages = []) => ({ id: newId(), updatedAt: Date.now(), messages })
const chatTitle = (chat) => chat.messages.find((message) => message.role === 'user')?.content.slice(0, 60) || 'New chat'
const timeAgo = (time) => {
    const minutes = Math.round((Date.now() - time) / 60000)
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes}m ago`
    if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`
    return `${Math.round(minutes / 1440)}d ago`
}

// The panel unmounts whenever the Activity Bar toggle is used, so chats live in storage:
// { activeId, chats: [{ id, updatedAt, messages }] }, newest first
const loadChats = (projectId) => {
    const clean = (messages) => (Array.isArray(messages) ? messages.filter((message) => !message.pending) : [])
    try {
        const saved = JSON.parse(localStorage.getItem(chatsKey(projectId)))
        if (saved?.chats?.length) {
            const chats = saved.chats.map((chat) => ({ ...chat, messages: clean(chat.messages) }))
            return { activeId: chats.some((chat) => chat.id === saved.activeId) ? saved.activeId : chats[0].id, chats }
        }
    } catch {
        // Unreadable storage starts fresh
    }
    // The single conversation saved before chats had history becomes the first chat
    let legacy
    try {
        legacy = clean(JSON.parse(localStorage.getItem(legacyKey(projectId))))
    } catch {
        legacy = []
    }
    const chat = createChat(legacy)
    return { activeId: chat.id, chats: [chat] }
}
const formatSize = (bytes) => bytes < 1024 * 1024
    ? `${bytes < 1024 ? bytes : Math.round(bytes / 1024)} ${bytes < 1024 ? 'B' : 'KB'}`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`

// A floating mascot for the empty state — blinks and drifts, nothing else
function RobotMark() {
    return (
        <motion.div
            className='relative'
            animate={{ y: [0, -6, 0] }}
            transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
        >
            <div className='absolute inset-0 rounded-full bg-sky-500/20 blur-2xl' />
            <svg width='78' height='78' viewBox='0 0 78 78' fill='none' className='relative'>
                <defs>
                    <linearGradient id='ameek-bot' x1='14' y1='14' x2='64' y2='66' gradientUnits='userSpaceOnUse'>
                        <stop stopColor='#38bdf8' />
                        <stop offset='1' stopColor='#a78bfa' />
                    </linearGradient>
                </defs>

                <motion.g
                    animate={{ opacity: [0.35, 1, 0.35] }}
                    transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
                >
                    <line x1='39' y1='9' x2='39' y2='19' stroke='url(#ameek-bot)' strokeWidth='2' strokeLinecap='round' />
                    <circle cx='39' cy='7' r='3.5' fill='url(#ameek-bot)' />
                </motion.g>

                <rect x='16' y='19' width='46' height='38' rx='13' fill='#17171a' stroke='url(#ameek-bot)' strokeWidth='2' />
                <rect x='24' y='28' width='30' height='19' rx='8' fill='#0b0b0d' />

                <motion.g
                    style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
                    animate={{ scaleY: [1, 1, 0.08, 1] }}
                    transition={{ duration: 3.4, times: [0, 0.82, 0.88, 0.94], repeat: Infinity, ease: 'easeInOut' }}
                >
                    <circle cx='33' cy='37.5' r='3.2' fill='url(#ameek-bot)' />
                    <circle cx='45' cy='37.5' r='3.2' fill='url(#ameek-bot)' />
                </motion.g>

                <rect x='10' y='31' width='5' height='13' rx='2.5' fill='url(#ameek-bot)' opacity='0.65' />
                <rect x='63' y='31' width='5' height='13' rx='2.5' fill='url(#ameek-bot)' opacity='0.65' />
                <path d='M25 62h28' stroke='url(#ameek-bot)' strokeWidth='2' strokeLinecap='round' opacity='0.5' />
                <path d='M31 68h16' stroke='url(#ameek-bot)' strokeWidth='2' strokeLinecap='round' opacity='0.25' />
            </svg>
        </motion.div>
    )
}

function EmptyState({ onPick }) {
    return (
        <div className='flex h-full flex-col items-center justify-center px-5 py-8 text-center'>
            <RobotMark />

            <h2 className='mt-5 bg-gradient-to-b from-white to-zinc-500 bg-clip-text text-2xl font-semibold tracking-tight text-transparent'>
                AmeekAi
            </h2>
            <p className='mt-1.5 max-w-[210px] text-[12px] leading-relaxed text-zinc-500'>
                Your coding companion. Ask about this workspace, or start with one of these.
            </p>

            <div className='mt-5 flex w-full flex-col gap-1.5'>
                {QUICK_ACTIONS.map(({ icon: Icon, label, prompt }, index) => (
                    <motion.button
                        key={label}
                        type='button'
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.06 * index + 0.1, duration: 0.25 }}
                        whileHover={{ x: 2 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => onPick(prompt)}
                        className='group flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-2
                        text-left text-[12px] font-medium text-zinc-400 transition-colors hover:border-sky-400/25 hover:bg-white/[0.05] hover:text-zinc-100'
                    >
                        <Icon size={13} className='shrink-0 text-zinc-600 transition-colors group-hover:text-sky-400' />
                        {label}
                    </motion.button>
                ))}
            </div>
        </div>
    )
}

function TypingDots() {
    return (
        <div className='flex items-center gap-1 py-1'>
            {[0, 1, 2].map((dot) => (
                <motion.span
                    key={dot}
                    className='size-1.5 rounded-full bg-zinc-500'
                    animate={{ opacity: [0.25, 1, 0.25], y: [0, -2, 0] }}
                    transition={{ duration: 1.1, repeat: Infinity, delay: dot * 0.15, ease: 'easeInOut' }}
                />
            ))}
        </div>
    )
}

function AttachmentChip({ file, onRemove }) {
    return (
        <span className='flex max-w-full items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.04] py-0.5 pl-1.5 pr-1 text-[10.5px] text-zinc-400'>
            {file.kind === 'image'
                ? <ImageIcon size={10} className='shrink-0 text-zinc-500' />
                : <FileText size={10} className='shrink-0 text-zinc-500' />}
            <span className='truncate'>{file.name}</span>
            <span className='shrink-0 text-zinc-600'>{formatSize(file.size)}</span>
            {onRemove && (
                <button
                    type='button'
                    onClick={onRemove}
                    title='Remove attachment'
                    className='shrink-0 rounded p-0.5 text-zinc-600 transition-colors hover:bg-white/[0.08] hover:text-zinc-200'
                >
                    <X size={10} />
                </button>
            )}
        </span>
    )
}

function StoredImage({ image, onClick, className = '', fit = 'cover' }) {
    const [source, setSource] = useState('')
    const [failed, setFailed] = useState(false)

    useEffect(() => {
        let active = true
        let objectUrl
        getAmeekAiImage(image.imageId)
            .then((blob) => {
                objectUrl = URL.createObjectURL(blob)
                if (active) setSource(objectUrl)
                else URL.revokeObjectURL(objectUrl)
            })
            .catch(() => {
                if (active) setFailed(true)
            })
        return () => {
            active = false
            if (objectUrl) URL.revokeObjectURL(objectUrl)
        }
    }, [image.imageId])

    if (failed) {
        return <div className={`flex items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03] text-[10px] text-zinc-500 ${className}`}>Image unavailable</div>
    }

    return (
        <button
            type='button'
            onClick={() => onClick?.(image)}
            disabled={!source || !onClick}
            aria-label={`View ${image.name}`}
            className={`overflow-hidden rounded-md bg-white/[0.04] disabled:cursor-default ${className}`}
        >
            {source
                ? <img src={source} alt={image.name} className={`size-full object-${fit}`} />
                : <span className='flex size-full min-h-12 items-center justify-center text-[10px] text-zinc-600'>Loading image…</span>}
        </button>
    )
}

// What AmeekAi did in the project during one reply, updated live while it works
function Steps({ steps }) {
    return (
        <ul className='mb-1.5 flex flex-col gap-0.5'>
            {steps.map((step) => (
                <li key={step.id} title={step.detail} className='flex items-start gap-1.5 text-[11px] leading-4 text-zinc-500'>
                    <span className='mt-[2px] flex size-3 shrink-0 items-center justify-center'>
                        {step.status === 'running' ? (
                            <motion.span
                                className='size-2.5 rounded-full border border-zinc-600 border-t-sky-400'
                                animate={{ rotate: 360 }}
                                transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
                            />
                        ) : step.status === 'error' ? (
                            <AlertCircle size={11} className='text-rose-400' />
                        ) : (
                            <Check size={11} className='text-emerald-400' />
                        )}
                    </span>
                    <span className='min-w-0 [overflow-wrap:anywhere]'>
                        <span className='text-zinc-400'>{step.verb}</span>{' '}
                        <span className='font-mono text-[10.5px] text-zinc-300'>{step.target}</span>
                    </span>
                </li>
            ))}
        </ul>
    )
}

function Message({ message, onRetry, onImageClick }) {
    if (message.role === 'user') {
        return (
            <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className='flex flex-col items-end gap-1'
            >
                <div className='max-w-[88%] rounded-2xl rounded-br-md bg-gradient-to-br from-sky-500 to-violet-500 px-3 py-2 text-[13px] leading-relaxed text-white shadow-lg shadow-sky-500/10 [overflow-wrap:anywhere]'>
                    {message.content}
                </div>
                {message.attachments?.some((file) => file.kind === 'image' && file.imageId) && (
                    <div className='flex max-w-[88%] flex-wrap justify-end gap-1'>
                        {message.attachments.filter((file) => file.kind === 'image' && file.imageId).map((image) => (
                            <StoredImage
                                key={image.imageId}
                                image={image}
                                onClick={onImageClick}
                                className='size-16 border border-white/[0.08]'
                            />
                        ))}
                    </div>
                )}
                {message.attachments?.filter((file) => file.kind !== 'image').length > 0 && (
                    <div className='flex max-w-[88%] flex-wrap justify-end gap-1'>
                        {message.attachments.filter((file) => file.kind !== 'image').map((file, index) => (
                            <AttachmentChip key={`${file.name}-${index}`} file={file} />
                        ))}
                    </div>
                )}
            </motion.div>
        )
    }

    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className='flex gap-2'
        >
            <div className='mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-sky-500/20 to-violet-500/20 ring-1 ring-white/[0.08]'>
                <Sparkles size={12} className='text-sky-400' />
            </div>

            <div className='min-w-0 flex-1 rounded-2xl rounded-tl-md border border-white/[0.06] bg-white/[0.03] px-3 py-2'>
                {message.steps?.length > 0 && <Steps steps={message.steps} />}
                {message.pending ? (
                    <TypingDots />
                ) : message.error ? (
                    <div className='flex flex-col items-start gap-1.5'>
                        <p className='text-[12.5px] leading-relaxed text-rose-300/90'>{message.content}</p>
                        <button
                            type='button'
                            onClick={onRetry}
                            className='flex items-center gap-1 rounded-md border border-white/[0.08] px-1.5 py-0.5 text-[11px] font-medium text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100'
                        >
                            <RotateCcw size={10} />
                            Retry
                        </button>
                    </div>
                ) : (
                    <Markdown content={message.content} />
                )}
            </div>
        </motion.div>
    )
}

function IconButton({ icon: Icon, title, onClick, disabled }) {
    return (
        <button
            type='button'
            onClick={onClick}
            disabled={disabled}
            title={title}
            aria-label={title}
            className='rounded p-0.5 text-zinc-500 transition-colors hover:bg-white/[0.08] hover:text-zinc-100 disabled:opacity-30'
        >
            <Icon size={12} />
        </button>
    )
}

// Files AmeekAi changed, waiting to be kept or undone; a file opens its diff in the editor
function ChangesPanel({ changes, onOpen, onKeep, onUndo, onRedo, onKeepAll, onUndoAll }) {
    const [open, setOpen] = useState(true)
    const [busy, setBusy] = useState(false)
    const counted = useMemo(
        () => changes.map((change) => ({ ...change, ...countLineChanges(change.before, change.after) })),
        [changes]
    )
    const pending = changes.filter((change) => change.state === 'pending').length
    const act = async (action, ...args) => {
        setBusy(true)
        try {
            await action(...args)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className='mb-2 overflow-hidden rounded-lg border border-white/[0.07] bg-white/[0.02]'>
            <div className='flex items-center justify-between gap-2 px-2 py-1.5'>
                <button
                    type='button'
                    onClick={() => setOpen(!open)}
                    className='flex min-w-0 items-center gap-1 text-[11.5px] font-medium text-zinc-300'
                >
                    <ChevronDown size={12} className={`shrink-0 text-zinc-500 transition-transform ${open ? '' : '-rotate-90'}`} />
                    {changes.length} file{changes.length === 1 ? '' : 's'} changed
                </button>
                <div className='flex shrink-0 items-center gap-1'>
                    <button
                        type='button'
                        onClick={() => act(onUndoAll)}
                        disabled={busy || !pending}
                        className='rounded px-1.5 py-0.5 text-[11px] text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-30'
                    >
                        Undo all
                    </button>
                    <button
                        type='button'
                        onClick={() => act(onKeepAll)}
                        disabled={busy}
                        className='rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-300 transition-colors hover:bg-emerald-500/25 disabled:opacity-30'
                    >
                        Keep all
                    </button>
                </div>
            </div>
            {open && (
                <ul className='max-h-36 overflow-y-auto border-t border-white/[0.05] py-1'>
                    {counted.map((change) => {
                        const undone = change.state === 'undone'
                        return (
                            <li key={change.path} className='group flex items-center gap-1.5 px-2 py-0.5'>
                                <button
                                    type='button'
                                    onClick={() => onOpen(change.path)}
                                    title={change.path}
                                    className={`min-w-0 flex-1 truncate text-left font-mono text-[11px] transition-colors hover:text-white
                                        ${undone ? 'text-zinc-600 line-through' : 'text-zinc-300'}`}
                                >
                                    {change.path}
                                </button>
                                <span className='shrink-0 font-mono text-[10.5px]'>
                                    {change.before === null ? (
                                        <span className='text-emerald-400'>new</span>
                                    ) : change.after === null ? (
                                        <span className='text-rose-400'>deleted</span>
                                    ) : (
                                        <>
                                            <span className='text-emerald-400'>+{change.added}</span>{' '}
                                            <span className='text-rose-400'>−{change.removed}</span>
                                        </>
                                    )}
                                </span>
                                {undone ? (
                                    <IconButton icon={Redo2} title='Redo' onClick={() => act(onRedo, change.path)} disabled={busy} />
                                ) : (
                                    <IconButton icon={Undo2} title='Undo' onClick={() => act(onUndo, change.path)} disabled={busy} />
                                )}
                                <IconButton icon={Check} title={undone ? 'Dismiss' : 'Keep'} onClick={() => onKeep(change.path)} disabled={busy} />
                            </li>
                        )
                    })}
                </ul>
            )}
        </div>
    )
}

function AiChat({
    projectId,
    context,
    onFilesChanged,
    onAiChange,
    getDrafts,
    aiChanges = [],
    onOpenChange,
    onKeepChange,
    onUndoChange,
    onRedoChange,
    onKeepAll,
    onUndoAll,
    onClose,
}) {
    const [store, setStore] = useState(() => loadChats(projectId))
    const [showHistory, setShowHistory] = useState(false)
    const [showImages, setShowImages] = useState(false)
    const [previewImage, setPreviewImage] = useState(null)
    const activeChat = store.chats.find((chat) => chat.id === store.activeId) || store.chats[0]
    const messages = activeChat.messages
    // Updates the open chat's messages; takes a new list or an updater, like a state setter
    const setMessages = (update) => setStore((current) => ({
        ...current,
        chats: current.chats.map((chat) => chat.id === current.activeId
            ? { ...chat, messages: typeof update === 'function' ? update(chat.messages) : update, updatedAt: Date.now() }
            : chat),
    }))
    const [input, setInput] = useState('')
    const [attachments, setAttachments] = useState([])
    const [attachmentError, setAttachmentError] = useState('')
    const [sending, setSending] = useState(false)

    const scrollRef = useRef(null)
    const textareaRef = useRef(null)
    const fileInputRef = useRef(null)
    const abortRef = useRef(null)
    const attachmentUrlsRef = useRef(new Set())

    // Stop a reply that is still running when the panel closes
    useEffect(() => () => {
        abortRef.current?.abort()
        attachmentUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
    }, [])

    useEffect(() => {
        try {
            const chats = store.chats
                .map((chat) => ({ ...chat, messages: chat.messages.filter((message) => !message.pending) }))
                .slice(0, MAX_CHATS)
            localStorage.setItem(chatsKey(projectId), JSON.stringify({ activeId: store.activeId, chats }))
            localStorage.removeItem(legacyKey(projectId))
        } catch {
            // Storage full or blocked — the session still works, it just will not persist
        }
    }, [store, projectId])

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }, [messages])

    // Grow with the content up to five lines, then scroll inside the textarea
    useLayoutEffect(() => {
        const node = textareaRef.current
        if (!node) return
        node.style.height = '0px'
        node.style.height = `${Math.min(node.scrollHeight, MAX_TEXTAREA)}px`
        node.style.overflowY = node.scrollHeight > MAX_TEXTAREA ? 'auto' : 'hidden'
    }, [input])

    const send = async (text, files) => {
        const content = text.trim()
        if ((!content && !files.length) || sending) return

        setSending(true)
        setAttachmentError('')
        const controller = new AbortController()
        abortRef.current = controller
        const readyFiles = []
        try {
            for (const file of files) {
                if (file.kind !== 'image' || file.imageId) {
                    readyFiles.push(file)
                    continue
                }
                const indexed = await uploadAmeekAiImage({ projectId, file: file.file, name: file.name, signal: controller.signal })
                const ready = { ...file, ...indexed }
                readyFiles.push(ready)
                setAttachments((previous) => previous.map((item) => item.id === file.id ? ready : item))
            }
        } catch (error) {
            if (abortRef.current === controller) abortRef.current = null
            setSending(false)
            if (!controller.signal.aborted) {
                setAttachmentError(error.response?.data?.message || error.message || 'AmeekAi could not process an image. Try again.')
            }
            return
        }

        const userMessage = {
            id: newId(),
            role: 'user',
            content,
            attachments: readyFiles.map(({ name, size, kind, imageId, mimeType }) => ({ name, size, kind, imageId, mimeType })),
        }
        const pendingId = newId()
        // Earlier turns only; failed replies are left out so the model does not repeat them
        const history = messages
            .filter((message) => !message.error && !message.pending && message.content)
            .map(({ role, content: body }) => ({ role: role === 'ai' ? 'assistant' : 'user', content: body }))

        setMessages([...messages, userMessage, { id: pendingId, role: 'ai', content: '', pending: true, steps: [] }])
        setInput('')
        readyFiles.forEach((file) => {
            if (file.previewUrl) {
                URL.revokeObjectURL(file.previewUrl)
                attachmentUrlsRef.current.delete(file.previewUrl)
            }
        })
        setAttachments([])

        const runner = createToolRunner({ projectId, onChange: onAiChange, getDrafts })
        const updatePending = (update) =>
            setMessages((prev) => prev.map((message) => (message.id === pendingId ? update(message) : message)))

        const { reply, error, stopped } = await runAmeekAi({
            projectId,
            message: content,
            history,
            attachments: readyFiles,
            context,
            signal: controller.signal,
            runTool: runner.run,
            onToolCall: (call) => updatePending((message) => ({
                ...message,
                steps: [...(message.steps || []), { id: call.id, ...describeToolCall(call), status: 'running' }],
            })),
            onToolResult: (call, result) => {
                // The Explorer and open tabs follow along as files change
                if (result.ok && CHANGING_TOOLS.has(call.name)) onFilesChanged?.()
                updatePending((message) => ({
                    ...message,
                    steps: message.steps.map((step) => step.id === call.id
                        ? { ...step, status: result.ok ? 'done' : 'error', detail: result.ok ? undefined : result.output.slice(0, 300) }
                        : step),
                }))
            },
        })

        if (abortRef.current === controller) abortRef.current = null
        updatePending((message) => ({
            id: pendingId,
            role: 'ai',
            steps: message.steps,
            content: stopped ? '_Stopped._' : error || reply || 'AmeekAi returned an empty response.',
            error: Boolean(error),
        }))
        setSending(false)
        textareaRef.current?.focus()
    }

    const retry = () => {
        const lastUser = [...messages].reverse().find((message) => message.role === 'user')
        if (!lastUser) return
        // Drop the failed exchange, then replay it
        setMessages((prev) => prev.slice(0, prev.findIndex((message) => message.id === lastUser.id)))
        const images = (lastUser.attachments || []).filter((file) => file.kind === 'image' && file.imageId)
        setTimeout(() => send(lastUser.content, images), 0)
    }

    const onKeyDown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            send(input, attachments)
        }
    }

    const addAttachments = async (picked) => {
        if (!picked.length) return
        setAttachmentError('')
        const pickedImages = picked.filter((file) => file.type.startsWith('image/'))
        const images = []
        const imageErrors = []
        for (const [index, file] of pickedImages.entries()) {
            try {
                const namedFile = file.name
                    ? file
                    : new File([file], `pasted-image-${Date.now()}-${index + 1}.png`, { type: file.type || 'image/png' })
                const prepared = await prepareAmeekAiImage(namedFile)
                const previewUrl = URL.createObjectURL(prepared)
                attachmentUrlsRef.current.add(previewUrl)
                images.push({
                    id: newId(),
                    kind: 'image',
                    file: prepared,
                    name: namedFile.name,
                    size: prepared.size,
                    mimeType: prepared.type,
                    previewUrl,
                })
            } catch (error) {
                imageErrors.push(`${file.name}: ${error.message}`)
            }
        }

        const pickedText = picked.filter((file) => !file.type.startsWith('image/'))
        const existingTextCount = attachments.filter((file) => file.kind !== 'image').length
        const room = Math.max(MAX_ATTACHMENTS - existingTextCount, 0)
        const textFiles = pickedText.slice(0, room)
        let files
        try {
            files = await Promise.all(textFiles.map(async (file) => ({
                id: newId(),
                kind: 'text',
                name: file.name,
                size: file.size,
                content: await file.slice(0, MAX_ATTACHMENT_BYTES).text(),
            })))
        } catch {
            images.forEach((file) => {
                URL.revokeObjectURL(file.previewUrl)
                attachmentUrlsRef.current.delete(file.previewUrl)
            })
            setAttachmentError(`A selected text file could not be read.${imageErrors.length ? ` ${imageErrors.join(' ')}` : ''}`)
            return
        }
        setAttachments((previous) => [...previous, ...images, ...files])

        const errors = [
            ...imageErrors,
            pickedText.length > textFiles.length && `You can attach up to ${MAX_ATTACHMENTS} non-image files at a time.`,
        ].filter(Boolean)
        if (errors.length) {
            setAttachmentError(errors.slice(0, 4).join(' '))
        }
    }

    const attach = (event) => {
        const picked = Array.from(event.target.files || [])
        event.target.value = ''
        void addAttachments(picked)
    }

    const onPaste = (event) => {
        const items = Array.from(event.clipboardData?.items || [])
        const pastedImages = items
            .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
            .map((item) => item.getAsFile())
            .filter(Boolean)
        const images = pastedImages.length
            ? pastedImages
            : Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/'))

        if (!images.length) return
        event.preventDefault()
        void addAttachments(images)
    }

    const usePrompt = (prompt) => {
        setInput(prompt)
        textareaRef.current?.focus()
    }

    // Starts a fresh conversation; an empty open chat is reused instead of piling up
    const newChat = () => {
        setShowHistory(false)
        setShowImages(false)
        setPreviewImage(null)
        setInput('')
        setAttachmentError('')
        attachments.forEach((file) => {
            if (file.previewUrl) {
                URL.revokeObjectURL(file.previewUrl)
                attachmentUrlsRef.current.delete(file.previewUrl)
            }
        })
        setAttachments([])
        if (messages.length) {
            const chat = createChat()
            setStore((current) => ({ activeId: chat.id, chats: [chat, ...current.chats].slice(0, MAX_CHATS) }))
        }
        textareaRef.current?.focus()
    }

    const openChat = (chatId) => {
        setStore((current) => ({ ...current, activeId: chatId }))
        setShowHistory(false)
        setShowImages(false)
        setPreviewImage(null)
    }

    const deleteChat = (chatId) => {
        setStore((current) => {
            const chats = current.chats.filter((chat) => chat.id !== chatId)
            if (!chats.length) {
                const chat = createChat()
                return { activeId: chat.id, chats: [chat] }
            }
            return { activeId: current.activeId === chatId ? chats[0].id : current.activeId, chats }
        })
    }

    const pastChats = [...store.chats].filter((chat) => chat.messages.length).sort((a, b) => b.updatedAt - a.updatedAt)
    const chatImages = [...new Map(
        messages.flatMap((message) => message.role === 'user' ? message.attachments || [] : [])
            .filter((file) => file.kind === 'image' && file.imageId)
            .map((image) => [image.imageId, image])
    ).values()]

    const canSend = (input.trim().length > 0 || attachments.length > 0) && !sending
    const stop = () => abortRef.current?.abort()

    return (
        <motion.div
            initial={{ opacity: 0, x: 16, width: 0 }}
            animate={{ opacity: 1, x: 0, width: 288 }}
            exit={{ opacity: 0, x: 16, width: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className='relative flex min-h-0 shrink-0 flex-col overflow-hidden border-l border-white/[0.06] bg-[#111113]/90 backdrop-blur-xl'
        >
            <div className='flex h-10 w-72 shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] px-3'>
                <div className='flex min-w-0 items-center gap-2'>
                    <div className='flex size-5 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-sky-500 to-violet-500'>
                        <Sparkles size={11} className='text-white' />
                    </div>
                    <span className='truncate text-[12px] font-semibold text-zinc-200'>AmeekAi</span>
                    <span className='flex shrink-0 items-center gap-1 text-[10px] font-medium text-zinc-500'>
                        <span className='relative flex size-1.5'>
                            <motion.span
                                className='absolute inline-flex size-full rounded-full bg-emerald-400'
                                animate={{ opacity: [0.6, 0, 0.6], scale: [1, 2.2, 1] }}
                                transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }}
                            />
                            <span className='relative inline-flex size-1.5 rounded-full bg-emerald-500' />
                        </span>
                        Active
                    </span>
                </div>

                <div className='flex shrink-0 items-center gap-0.5'>
                    <button
                        type='button'
                        onClick={newChat}
                        disabled={sending || messages.length === 0}
                        title='New Chat'
                        aria-label='New Chat'
                        className='rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 disabled:pointer-events-none disabled:opacity-30'
                    >
                        <MessageSquarePlus size={14} />
                    </button>
                    <button
                        type='button'
                        onClick={() => {
                            setShowHistory(false)
                            setShowImages(!showImages)
                        }}
                        disabled={sending || chatImages.length === 0}
                        title='Images in this chat'
                        aria-label={`Images in this chat (${chatImages.length})`}
                        className={`relative rounded-md p-1 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 disabled:pointer-events-none disabled:opacity-30
                            ${showImages ? 'bg-white/[0.06] text-zinc-200' : 'text-zinc-500'}`}
                    >
                        <ImageIcon size={14} />
                        {chatImages.length > 0 && (
                            <span className='absolute -right-1 -top-1 flex min-w-3.5 items-center justify-center rounded-full bg-sky-500 px-0.5 text-[8px] leading-3 text-white'>
                                {chatImages.length}
                            </span>
                        )}
                    </button>
                    <button
                        type='button'
                        onClick={() => {
                            setShowImages(false)
                            setShowHistory(!showHistory)
                        }}
                        disabled={sending || pastChats.length === 0}
                        title='Chat History'
                        aria-label='Chat History'
                        className={`rounded-md p-1 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 disabled:pointer-events-none disabled:opacity-30
                            ${showHistory ? 'bg-white/[0.06] text-zinc-200' : 'text-zinc-500'}`}
                    >
                        <History size={14} />
                    </button>
                    {onClose && (
                        <button
                            type='button'
                            onClick={onClose}
                            title='Close AI Chat'
                            aria-label='Close AI Chat'
                            className='rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200'
                        >
                            <X size={14} />
                        </button>
                    )}
                </div>
            </div>

            <AnimatePresence>
                {showHistory && (
                    <motion.div
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.15 }}
                        className='absolute inset-x-0 top-10 z-20 max-h-80 w-72 overflow-y-auto border-b border-white/[0.08] bg-[#131316] py-1 shadow-2xl shadow-black/60'
                    >
                        <div className='px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600'>Chats</div>
                        {pastChats.map((chat) => (
                            <div
                                key={chat.id}
                                className={`group mx-1 flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-white/[0.05]
                                    ${chat.id === store.activeId ? 'bg-white/[0.04]' : ''}`}
                            >
                                <button type='button' onClick={() => openChat(chat.id)} className='min-w-0 flex-1 text-left'>
                                    <span className='block truncate text-[12px] text-zinc-300'>{chatTitle(chat)}</span>
                                    <span className='text-[10px] text-zinc-600'>{timeAgo(chat.updatedAt)}</span>
                                </button>
                                <button
                                    type='button'
                                    onClick={() => deleteChat(chat.id)}
                                    title='Delete chat'
                                    aria-label='Delete chat'
                                    className='shrink-0 rounded p-1 text-zinc-600 opacity-0 transition hover:bg-white/[0.08] hover:text-rose-300 group-hover:opacity-100'
                                >
                                    <Trash2 size={12} />
                                </button>
                            </div>
                        ))}
                    </motion.div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {showImages && (
                    <motion.section
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.15 }}
                        aria-label='Images sent in this chat'
                        className='absolute inset-x-0 bottom-0 top-10 z-20 flex flex-col border-t border-white/[0.06] bg-[#131316] shadow-2xl shadow-black/60'
                    >
                        <div className='flex h-9 shrink-0 items-center justify-between border-b border-white/[0.06] px-3'>
                            <span className='text-[11px] font-semibold text-zinc-300'>Images · {chatImages.length}</span>
                            <button
                                type='button'
                                onClick={() => setShowImages(false)}
                                title='Close images'
                                aria-label='Close images'
                                className='rounded p-1 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200'
                            >
                                <X size={12} />
                            </button>
                        </div>
                        <div className='grid grid-cols-3 content-start gap-2 overflow-y-auto p-2'>
                            {chatImages.map((image) => (
                                <div key={image.imageId} className='min-w-0'>
                                    <StoredImage
                                        image={image}
                                        onClick={setPreviewImage}
                                        className='aspect-square w-full border border-white/[0.08]'
                                    />
                                    <span className='mt-1 block truncate text-[9px] text-zinc-500' title={image.name}>{image.name}</span>
                                </div>
                            ))}
                        </div>
                    </motion.section>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {previewImage && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        role='dialog'
                        aria-modal='true'
                        aria-label={previewImage.name}
                        className='absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 bg-black/90 p-4'
                    >
                        <button
                            type='button'
                            onClick={() => setPreviewImage(null)}
                            title='Close image preview'
                            aria-label='Close image preview'
                            className='absolute right-2 top-2 rounded-md bg-white/[0.08] p-1.5 text-zinc-300 hover:bg-white/[0.15]'
                        >
                            <X size={14} />
                        </button>
                        <StoredImage
                            key={previewImage.imageId}
                            image={previewImage}
                            className='h-[70vh] max-h-[70vh] w-full max-w-full bg-transparent'
                            fit='contain'
                        />
                        <span className='max-w-full truncate text-[11px] text-zinc-400'>{previewImage.name}</span>
                    </motion.div>
                )}
            </AnimatePresence>

            <div
                ref={scrollRef}
                className='w-72 flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent
                [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/[0.08]
                hover:[&::-webkit-scrollbar-thumb]:bg-white/[0.15] [&::-webkit-scrollbar-thumb]:transition-colors'
                style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.1) transparent' }}
            >
                {messages.length === 0 ? (
                    <EmptyState onPick={usePrompt} />
                ) : (
                    <div className='flex flex-col gap-3 px-3 py-3'>
                        {messages.map((message) => (
                            <Message key={message.id} message={message} onRetry={retry} onImageClick={setPreviewImage} />
                        ))}
                    </div>
                )}
            </div>

            <div className='w-72 shrink-0 border-t border-white/[0.06] bg-[#111113]/95 px-2.5 py-2'>
                {attachmentError && (
                    <p role='alert' className='mb-1.5 flex items-start gap-1 text-[10.5px] leading-4 text-rose-300'>
                        <AlertCircle size={12} className='mt-0.5 shrink-0' />
                        {attachmentError}
                    </p>
                )}
                {aiChanges.length > 0 && (
                    <ChangesPanel
                        changes={aiChanges}
                        onOpen={onOpenChange}
                        onKeep={onKeepChange}
                        onUndo={onUndoChange}
                        onRedo={onRedoChange}
                        onKeepAll={onKeepAll}
                        onUndoAll={onUndoAll}
                    />
                )}
                <AnimatePresence initial={false}>
                    {attachments.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.15 }}
                            className='flex flex-wrap gap-1 overflow-hidden pb-1.5'
                        >
                            {attachments.map((file, index) => (
                                <AttachmentChip
                                    key={file.id}
                                    file={file}
                                    onRemove={() => {
                                        const removed = attachments[index]
                                        if (removed.previewUrl) {
                                            URL.revokeObjectURL(removed.previewUrl)
                                            attachmentUrlsRef.current.delete(removed.previewUrl)
                                        }
                                        setAttachments((prev) => prev.filter((_, i) => i !== index))
                                        setAttachmentError('')
                                    }}
                                />
                            ))}
                        </motion.div>
                    )}
                </AnimatePresence>

                <div className='rounded-xl border border-white/[0.07] bg-white/[0.03] transition-colors focus-within:border-sky-400/40 focus-within:bg-white/[0.05]'>
                    <textarea
                        ref={textareaRef}
                        rows={1}
                        value={input}
                        onChange={(event) => setInput(event.target.value)}
                        onKeyDown={onKeyDown}
                        onPaste={onPaste}
                        placeholder='Ask AmeekAi anything... (paste an image)'
                        className='block w-full resize-none bg-transparent px-2.5 py-2 text-[13px] leading-5 text-zinc-200 outline-none
                        placeholder:text-zinc-600 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent
                        [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/[0.08]'
                        style={{ maxHeight: MAX_TEXTAREA, scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.1) transparent' }}
                    />

                    <div className='flex items-center justify-between gap-2 px-1.5 pb-1.5'>
                        <div className='flex items-center gap-1'>
                            <input ref={fileInputRef} type='file' accept='image/*,.txt,.md,.js,.jsx,.ts,.tsx,.json,.html,.css,.py,.java,.go,.rs,.c,.cpp,.h,.sql' multiple hidden onChange={attach} />
                            <button
                                type='button'
                                onClick={() => fileInputRef.current?.click()}
                                disabled={sending}
                                title='Attach images or text files'
                                aria-label='Attach files'
                                className='rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 disabled:pointer-events-none disabled:opacity-30'
                            >
                                <Paperclip size={14} />
                            </button>
                            <span className='hidden text-[10px] text-zinc-600 sm:inline'>
                                <kbd className='font-sans'>Shift</kbd> + <kbd className='font-sans'>Enter</kbd> for newline
                            </span>
                        </div>

                        {sending ? (
                            <motion.button
                                type='button'
                                onClick={stop}
                                whileHover={{ scale: 1.06 }}
                                whileTap={{ scale: 0.94 }}
                                title='Stop'
                                aria-label='Stop'
                                className='flex size-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.08] text-zinc-200 transition-colors hover:bg-white/[0.12]'
                            >
                                <Square size={11} fill='currentColor' />
                            </motion.button>
                        ) : (
                            <motion.button
                                type='button'
                                onClick={() => send(input, attachments)}
                                disabled={!canSend}
                                whileHover={canSend ? { scale: 1.06 } : undefined}
                                whileTap={canSend ? { scale: 0.94 } : undefined}
                                title='Send message'
                                aria-label='Send message'
                                className={`flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors ${canSend
                                    ? 'bg-gradient-to-br from-sky-500 to-violet-500 text-white shadow-lg shadow-sky-500/20'
                                    : 'bg-white/[0.05] text-zinc-600'
                                    }`}
                            >
                                <ArrowUp size={15} strokeWidth={2.5} />
                            </motion.button>
                        )}
                    </div>
                </div>
            </div>
        </motion.div>
    )
}

export default AiChat
