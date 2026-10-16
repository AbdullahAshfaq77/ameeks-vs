import React, { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useDispatch, useSelector } from 'react-redux'
import TopBar from '../components/TopBar'
import { getProject, linkProjectFolder } from '../features/project'
import { createRootFolder, getTree } from '../features/file'
import { createToolRunner } from '../features/aiTools'
import * as browserFs from '../utils/browserFs'
import { setCurrentProject } from '../redux/projectSlice'
import ActivityBar from '../components/ActivityBar'
import Explorer from '../components/Explorer'
import { AnimatePresence, motion } from 'motion/react'
import { Code2, Eye, Maximize2, Minimize2 } from 'lucide-react'
import Preview from '../components/Preview'
import Editor from '../components/Editor'
import BottomPanel from '../components/BottomPanel'
import AiChat from '../components/AiChat'

// Path of a node inside the project, e.g. ["src", "app.js"]; the root folder itself is left out
const pathInProject = (nodes, id, parents = []) => {
  for (const node of nodes || []) {
    const path = [...parents, node.name]
    if (node._id === id) return path
    const found = pathInProject(node.children, id, path)
    if (found) return found
  }
  return null
}

function ProjectPage() {

  const [showExplorer, setShowExplorer] = useState(false)
  const [showChat, setShowChat] = useState(false)
  const [showpreview, setShowPreview] = useState(false)
  const [isPreviewFullScreen, setIsPreviewFullScreen] = useState(false)
  const [tree, setTree] = useState([])
  const [openTabs,setOpenTabs] = useState([])
  const [showBottomPannel,setshowBottomPannel] = useState(false)
  const [activeTab , setActiveTab] = useState(null)
  
  // Unsaved editor content by file id, shared so the preview shows edits before they are saved
  const [drafts, setDrafts] = useState({})
  // Read by AmeekAi's tools mid-run, so they always see the latest unsaved text
  const draftsRef = useRef(drafts)
  useEffect(() => { draftsRef.current = drafts }, [drafts])
  const { id } = useParams()
  const dispatch = useDispatch()
  const currentProject = useSelector((state) => state.project.currentProject)
  const loadedId = currentProject?._id
  const loadedFolderName = currentProject?.folderName
  // For a folder chosen in the browser: 'ready', or why it can't be opened yet (see browserFs.connect)
  const [folderStatus, setFolderStatus] = useState(null)
  // Files AmeekAi changed, for review: { path, fileId, name, before, after, state: 'pending' | 'undone' }.
  // before is null for a file it created, after is null for one it deleted.
  const [aiChanges, setAiChanges] = useState([])
  // Reloads can overlap (AmeekAi changes files in quick succession), so only the latest one lands
  const loadSeq = useRef(0)
  const loadTree = async () => {
    const seq = ++loadSeq.current
    const data = await getTree(id)
    if (seq === loadSeq.current && data) setTree(data)
  }
  useEffect(() => {
    let cancelled = false

    const loadInitialData = async () => {
      // Redux is cleared on refresh, so load the project from the URL id when needed.
      // It comes first: a local project's tree is read from its folder, not the files service.
      let folderName = loadedFolderName
      if (loadedId !== id) {
        const project = await getProject(id)
        if (cancelled) return
        if (project) dispatch(setCurrentProject(project))
        folderName = project?.folderName
      }
      if (folderName) {
        const status = await browserFs.connect(id)
        if (cancelled) return
        setFolderStatus(status)
        if (status !== 'ready') {
          // Needs a click to reconnect, which the Explorer offers
          setTree([])
          setShowExplorer(true)
          return
        }
      }

      const treeData = await getTree(id)
      if (cancelled) return
      setTree(treeData)
      if (!folderName) {
        // No folder and no root folder in the cloud: offer both instead of an empty Explorer
        const empty = !treeData?.length
        setFolderStatus(empty ? 'empty' : null)
        if (empty) setShowExplorer(true)
      }
    }

    loadInitialData()
    return () => {
      cancelled = true
    }
  }, [id, loadedId, loadedFolderName, dispatch])

  // Browsers only allow folder access from a click, so reconnecting happens here
  const connectFolder = async ({ chooseAnother = false, cloud = false } = {}) => {
    if (cloud) {
      // An empty project that keeps its files in the cloud needs its root folder
      await createRootFolder({ projectId: id, projectName: currentProject?.name || 'project' })
      setFolderStatus(null)
      loadTree()
      return
    }
    const linking = folderStatus === 'empty'
    let status = chooseAnother || linking ? 'missing' : await browserFs.connect(id, { request: true })
    if (status === 'missing') {
      const handle = await browserFs.pickFolder()
      if (!handle) return
      await browserFs.linkFolder(id, handle)
      if (linking) {
        const project = await linkProjectFolder(id, handle.name)
        if (project) dispatch(setCurrentProject(project))
      }
      status = 'ready'
    }
    setFolderStatus(status)
    if (status === 'ready') loadTree()
  }

  // The browser asks again for a remembered folder on a new visit, and only a click may
  // trigger that, so the first click anywhere reconnects it. Choosing "Allow on every
  // visit" in the browser's prompt stops it asking at all.
  useEffect(() => {
    if (folderStatus !== 'permission') return
    const reconnect = async () => {
      const status = await browserFs.connect(id, { request: true })
      if (status !== 'ready') return
      setFolderStatus('ready')
      const data = await getTree(id)
      if (data) setTree(data)
    }
    window.addEventListener('pointerdown', reconnect, { once: true, capture: true })
    return () => window.removeEventListener('pointerdown', reconnect, { capture: true })
  }, [id, folderStatus])

  useEffect(() => {
    if (folderStatus !== 'ready') return
    return browserFs.watch(id, async () => {
      const data = await getTree(id)
      if (data) setTree(data)
    })
  }, [id, folderStatus])

  // Leaving the preview (from any toggle) also leaves fullscreen
  const setPreview = (value) => {
    setShowPreview(value)
    if (!value) setIsPreviewFullScreen(false)
  }

  useEffect(() => {
    if (!isPreviewFullScreen) return
    const onKey = (e) => e.key === 'Escape' && setIsPreviewFullScreen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isPreviewFullScreen])

  const openFile = (file) => {
    setOpenTabs(prev => prev.some(tab => tab._id == file._id) ? prev : [...prev, file])
    setActiveTab(file)
    setPreview(false)
  }

  // ---------- AmeekAi's changes: shown live as a diff, then kept, undone or redone ----------

  const recordAiChange = (change) => {
    setAiChanges(prev => {
      const existing = prev.find(c => c.path === change.path)
      // Several edits to one file are one change: from its first "before" to its latest "after"
      const merged = existing
        ? { ...existing, fileId: change.fileId, name: change.name, after: change.after, state: 'pending' }
        : { ...change, state: 'pending' }
      const rest = prev.filter(c => c.path !== change.path)
      return merged.before === merged.after ? rest : [...rest, merged]
    })
    // The AI worked from the unsaved text and saved its result, so that draft is now on disk;
    // dropping it lets the open tab show the AI's version
    setDrafts(d => {
      if (!(change.fileId in d)) return d
      const rest = { ...d }
      delete rest[change.fileId]
      return rest
    })
    // Follow along: the file the AI just changed opens in the editor, showing the diff
    if (change.after !== null) openFile({ _id: change.fileId, name: change.name, type: 'file', content: change.after })
  }

  // Writes a version of a changed file back by path (null deletes it), then refreshes
  const applyVersion = async (change, content) => {
    const runner = createToolRunner({ projectId: id })
    const call = content === null
      ? { id: 'review', name: 'delete_path', args: { path: change.path } }
      : { id: 'review', name: 'write_file', args: { path: change.path, content } }
    const result = await runner.run(call)
    await loadTree()
    return result.ok
  }

  const setChangeState = (path, state) =>
    setAiChanges(prev => prev.map(c => (c.path === path ? { ...c, state } : c)))

  const keepChange = (path) => setAiChanges(prev => prev.filter(c => c.path !== path))

  const undoChange = async (path) => {
    const change = aiChanges.find(c => c.path === path)
    if (change && await applyVersion(change, change.before)) setChangeState(path, 'undone')
  }

  const redoChange = async (path) => {
    const change = aiChanges.find(c => c.path === path)
    if (change && await applyVersion(change, change.after)) setChangeState(path, 'pending')
  }

  const undoAllChanges = async () => {
    for (const change of aiChanges.filter(c => c.state === 'pending')) {
      if (await applyVersion(change, change.before)) setChangeState(change.path, 'undone')
    }
  }

  const keepAllChanges = () => setAiChanges([])

  // Tree ids can change (a file recreated by redo), so the open file is matched by path
  const rootOffset = tree.length === 1 && tree[0].type === 'folder' ? 1 : 0
  const activePath = activeTab ? pathInProject(tree, activeTab._id)?.slice(rootOffset).join('/') : undefined
  const activeAiChange = activePath
    ? aiChanges.find(c => c.path === activePath)
    : aiChanges.find(c => c.fileId === activeTab?._id)

  const openChangedFile = (path) => {
    const change = aiChanges.find(c => c.path === path)
    if (!change || change.after === null && change.state === 'pending') return
    const find = (nodes, parts) => {
      const node = nodes?.find(n => n.name === parts[0])
      return parts.length === 1 ? node : find(node?.children, parts.slice(1))
    }
    const top = rootOffset ? tree[0].children : tree
    const node = find(top, path.split('/'))
    if (node) openFile(node)
  }

  return (
    <div className='relative flex h-screen flex-col overflow-hidden bg-[#0a0a0c]'>
      <div className='pointer-events-none absolute -top-40 left-1/3 h-96 w-96 rounded-full bg-sky-500/10 blur-[140px]' />
      <div className='pointer-events-none absolute -top-20 right-1/4 h-80 w-80 rounded-full bg-violet-500/10 blur-[140px]' />
      <TopBar
        showpreview={showpreview}
        setShowPreview={setPreview}
      />
      <div className='flex flex-1 overflow-hidden'>
        <ActivityBar
          showExplorer={showExplorer}
          setShowExplorer={setShowExplorer}
          showChat={showChat}
          setShowChat={setShowChat}
          showTerminal={showBottomPannel}
          setShowTerminal={setshowBottomPannel}
        />
        <AnimatePresence initial={false}>
          {showExplorer && (
            <Explorer
              projectId={id}
              tree={tree}
              openFile={openFile}
              folderPrompt={folderStatus && folderStatus !== 'ready'
                ? { status: folderStatus, folderName: loadedFolderName, onConnect: connectFolder }
                : null}

              reloadTree={loadTree}

            />
          )}
        </AnimatePresence>
        <div className={isPreviewFullScreen
          ? 'fixed inset-0 z-50 flex flex-col overflow-hidden bg-[#0a0a0c]'
          : 'relative flex w-full min-w-0 flex-1 flex-col overflow-hidden border-x border-white/[0.05]'}>
          <div className='pointer-events-none absolute right-2 top-2 z-40 flex items-center gap-1.5 sm:right-4 sm:top-3 sm:gap-2'>
            <AnimatePresence>
              {showpreview && (
                <motion.button
                  key="fullscreen"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  type="button"
                  onClick={() => setIsPreviewFullScreen((v) => !v)}
                  title={isPreviewFullScreen ? "Exit fullscreen" : "Fullscreen preview"}
                  className="pointer-events-auto flex items-center justify-center rounded-lg border border-white/10 bg-[#111113]/95 p-1.5 text-zinc-400 shadow-lg shadow-black/40 backdrop-blur hover:text-white sm:p-2"
                >
                  {isPreviewFullScreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                </motion.button>
              )}
              <div
                key="view-toggle"
                className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-white/10 bg-[#111113]/95 p-1 
                shadow-lg shadow-black/40 backdrop-blur"
              >
                <button
                  onClick={() => setPreview(false)}
                  className={`relative flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors 
                    sm:px-3 sm:py-1.5 sm:text-xs ${!showpreview ? "text-white" : "text-zinc-500 hover:text-zinc-300"}`}
                >
                  {!showpreview && (
                    <motion.div
                      className="absolute inset-0 rounded-md bg-gradient-to-b from-zinc-700 to-zinc-800"
                      transition={{ type: "spring", duration: 0.4, bounce: 0.15 }}
                    />

                  )
                  }
                  <Code2 size={13} className='relative'/>
                  <span className='relative hidden sm:inline'>Editor</span>




                </button>
                <button onClick={() => setPreview(true)}
                  className={`relative flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors 
                    sm:px-3 sm:py-1.5 sm:text-xs ${showpreview ? "text-white" : "text-zinc-500 hover:text-zinc-300"}`}
                >
                   {showpreview && (
                    <motion.div
                      className="absolute inset-0 rounded-md bg-gradient-to-b from-zinc-700 to-zinc-800"
                      transition={{ type: "spring", duration: 0.4, bounce: 0.15 }}
                    />

                  )
                  }
                  <Eye size={13} className='relative'/>
                 <span className='relative hidden sm:inline'>Preview</span>
                </button>


              </div>
            </AnimatePresence>
          </div>
          <div className='flex min-h-0 flex-1 overflow-hidden'>
                {showpreview && <Preview tree={tree} drafts={drafts} activeTab={activeTab} />}
                {/* Kept mounted while previewing so unsaved edits and undo history survive */}
                <div className={showpreview ? 'hidden' : 'flex min-w-0 flex-1'}>
                  <Editor
                    tree={tree}
                    activeTab={activeTab}
                    openTabs={openTabs}
                    setOpenTabs={setOpenTabs}
                    setActiveTab={setActiveTab}
                    drafts={drafts}
                    setDrafts={setDrafts}
                    onSaved={loadTree}
                    aiChange={activeAiChange}
                    onKeepChange={keepChange}
                    onUndoChange={undoChange}
                    onRedoChange={redoChange}
                  />
                </div>
          </div>
          <AnimatePresence>
            {showBottomPannel && !isPreviewFullScreen && (
              <div className='flex max-h-[45vh] shrink-0 flex-col overflow-hidden md:max-h-none'>
                  <BottomPanel
                  projectId={id}
                  tree={tree}
                  reloadTree={loadTree}
                  openFile={openFile}
                  onClose={() => setshowBottomPannel(false)}
                  />
              </div>
            )}
          </AnimatePresence>
        </div>
        {/* Secondary sidebar: AmeekAi sits opposite the Explorer */}
        <AnimatePresence initial={false}>
          {showChat && (
            <AiChat
              key={id}
              projectId={id}
              context={{
                projectName: currentProject?.name,
                folderName: currentProject?.folderName,
                activeFile: activePath,
              }}
              onFilesChanged={loadTree}
              onAiChange={recordAiChange}
              getDrafts={() => draftsRef.current}
              aiChanges={aiChanges}
              onOpenChange={openChangedFile}
              onKeepChange={keepChange}
              onUndoChange={undoChange}
              onRedoChange={redoChange}
              onKeepAll={keepAllChanges}
              onUndoAll={undoAllChanges}
              onClose={() => setShowChat(false)}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

export default ProjectPage