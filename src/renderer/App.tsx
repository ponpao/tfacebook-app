// ---------------------------------------------------------------------------
// App.tsx  — WinForms-style shell:
//   TitleBar → MenuBar → RibbonToolbar → AccountsGrid → StatusBar
//   plus the import modal and folder-management dialogs.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react'
import { LicenseGateModal } from './components/LicenseGateModal'
import { TitleBar } from './components/TitleBar'
import { MenuBar } from './components/MenuBar'
import { RibbonToolbar } from './components/RibbonToolbar'
import { AccountsGrid } from './components/table/AccountsGrid'
import { StatusBar } from './components/StatusBar'
import { ImportModal } from './components/modals/ImportModal'
import { FolderDialogs, type FolderDialogMode } from './components/modals/FolderDialogs'
import { ColumnVisibilityModal } from './components/modals/ColumnVisibilityModal'
import { ScenarioBuilderModal } from './components/modals/ScenarioBuilderModal'
import { ExportAccountsModal } from './components/modals/ExportAccountsModal'
import { RecycleBinModal } from './components/modals/RecycleBinModal'
import { GeneralSettingsModal } from './components/modals/GeneralSettingsModal'
import { ToolsUtilitiesModal } from './components/modals/ToolsUtilitiesModal'
import { EditAccountModal } from './components/modals/EditAccountModal'
import { HelpAboutModal } from './components/modals/HelpAboutModal'
import { SetNotesModal } from './components/modals/SetNotesModal'
import { CleanProfileModal } from './components/modals/CleanProfileModal'
import { UpdateNotificationModal } from './components/modals/UpdateNotificationModal'
import { useAccountStore } from './store/useAccountStore'
import { ALL_FOLDERS } from '../types/folder'
import type { LicenseStatus } from '../types/license'

export default function App(): React.JSX.Element {
  const [license, setLicense] = useState<LicenseStatus | null>(null)

  useEffect(() => {
    void window.api.license.getStatus().then(setLicense)
  }, [])

  // Block on the license gate until we know the activation state, then keep
  // blocking (rendering the gate, not the dashboard) until it's activated —
  // the dashboard tree below never mounts otherwise.
  if (!license) {
    return <div className="flex h-screen items-center justify-center bg-mc-bg" />
  }
  if (!license.isActivated) {
    return (
      <LicenseGateModal
        deviceHash={license.deviceHash}
        initialMessage={license.message}
        onActivated={setLicense}
      />
    )
  }

  return <Dashboard onRequireActivation={() => setLicense({ isActivated: false, deviceHash: license.deviceHash })} />
}

function Dashboard({
  onRequireActivation
}: {
  onRequireActivation: () => void
}): React.JSX.Element {
  const [importOpen, setImportOpen] = useState(false)
  const [folderMode, setFolderMode] = useState<FolderDialogMode>(null)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [scenarioBuilderOpen, setScenarioBuilderOpen] = useState(false)
  const [generalSettingsOpen, setGeneralSettingsOpen] = useState(false)
  const [toolsUtilitiesOpen, setToolsUtilitiesOpen] = useState(false)
  const [helpAboutOpen, setHelpAboutOpen] = useState(false)

  const refresh = useAccountStore((s) => s.refresh)
  const refreshFolders = useAccountStore((s) => s.refreshFolders)
  const refreshScenarios = useAccountStore((s) => s.refreshScenarios)
  const folders = useAccountStore((s) => s.folders)
  const folderId = useAccountStore((s) => s.folderId)
  const selectedIds = useAccountStore((s) => s.selectedIds)
  const rowSelection = useAccountStore((s) => s.rowSelection)

  const initQueueListeners = useAccountStore((s) => s.initQueueListeners)
  const exportModalOpen = useAccountStore((s) => s.exportModalOpen)
  const closeExportModal = useAccountStore((s) => s.closeExportModal)
  const recycleBinOpen = useAccountStore((s) => s.recycleBinOpen)
  const closeRecycleBin = useAccountStore((s) => s.closeRecycleBin)
  const setNotesTargetIds = useAccountStore((s) => s.setNotesTargetIds)
  const closeSetNotes = useAccountStore((s) => s.closeSetNotes)
  const cleanProfileTargetIds = useAccountStore((s) => s.cleanProfileTargetIds)
  const closeCleanProfile = useAccountStore((s) => s.closeCleanProfile)

  useEffect(() => {
    void refreshFolders()
    void refreshScenarios()
    void refresh()
  }, [refresh, refreshFolders, refreshScenarios])

  // Subscribe once for the app's lifetime — the queue can outlive any single
  // component that triggered it.
  useEffect(() => initQueueListeners(), [initQueueListeners])

  const activeFolder =
    folderId === ALL_FOLDERS ? null : folders.find((f) => f.id === folderId) ?? null
  const selectedCount = Object.values(rowSelection).filter(Boolean).length

  const handleCreate = async (name: string): Promise<void> => {
    const created = await window.api.folders.create(name)
    await refreshFolders()
    useAccountStore.getState().setFolderId(created.id)
  }
  const handleRename = async (id: number, name: string): Promise<void> => {
    await window.api.folders.rename(id, name)
    await refreshFolders()
  }
  const handleDelete = async (id: number, fallbackId: number): Promise<void> => {
    await window.api.folders.delete(id, fallbackId)
    await refreshFolders()
    useAccountStore.getState().setFolderId(ALL_FOLDERS)
  }
  const handleMove = async (targetFolderId: number): Promise<void> => {
    await useAccountStore.getState().moveToFolder(selectedIds(), targetFolderId)
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden border-t-4 border-blue-900 bg-mc-bg">
      <TitleBar />
      <MenuBar
        onDisplayColumns={() => setColumnsOpen(true)}
        onScenarioBuilder={() => setScenarioBuilderOpen(true)}
        onGeneralSettings={() => setGeneralSettingsOpen(true)}
        onToolsUtilities={() => setToolsUtilitiesOpen(true)}
        onHelpAbout={() => setHelpAboutOpen(true)}
      />
      <RibbonToolbar
        onImport={() => setImportOpen(true)}
        onFolderDialog={setFolderMode}
      />

      <main className="flex flex-1 flex-col overflow-hidden p-1.5">
        <AccountsGrid />
      </main>

      <StatusBar />

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
      <ColumnVisibilityModal
        open={columnsOpen}
        onClose={() => setColumnsOpen(false)}
      />
      <ScenarioBuilderModal
        open={scenarioBuilderOpen}
        onClose={() => setScenarioBuilderOpen(false)}
      />
      <ExportAccountsModal open={exportModalOpen} onClose={closeExportModal} />
      <RecycleBinModal open={recycleBinOpen} onClose={closeRecycleBin} />
      <GeneralSettingsModal
        open={generalSettingsOpen}
        onClose={() => setGeneralSettingsOpen(false)}
      />
      <ToolsUtilitiesModal
        open={toolsUtilitiesOpen}
        onClose={() => setToolsUtilitiesOpen(false)}
      />
      <HelpAboutModal
        open={helpAboutOpen}
        onClose={() => setHelpAboutOpen(false)}
        onRequireActivation={onRequireActivation}
      />
      <EditAccountModal />
      <SetNotesModal accountIds={setNotesTargetIds} onClose={closeSetNotes} />
      <CleanProfileModal accountIds={cleanProfileTargetIds} onClose={closeCleanProfile} />
      <UpdateNotificationModal />
      <FolderDialogs
        mode={folderMode}
        folders={folders}
        activeFolder={activeFolder}
        selectedCount={selectedCount}
        onClose={() => setFolderMode(null)}
        onCreate={handleCreate}
        onRename={handleRename}
        onDelete={handleDelete}
        onMove={handleMove}
      />
    </div>
  )
}
