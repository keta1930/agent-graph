// 图编辑器主组件
import React, { useEffect, useState, useMemo } from 'react';
import { Alert, App, message } from 'antd';
import AddNodeModal from '../components/graph-editor/AddNodeModal';
import GraphVersionManager from '../components/graph-editor/GraphVersionManager';
import GraphListView from '../components/graph-editor/GraphListView';
import GraphEditorView from '../components/graph-editor/GraphEditorView';
import CreateGraphModal from '../components/graph-editor/CreateGraphModal';
import GraphSettingsModal from '../components/graph-editor/GraphSettingsModal';
import ReadmeModal from '../components/graph-editor/ReadmeModal';

import { useGraphEditorStore } from '../store/graphEditorStore';
import { useMCPStore } from '../store/mcpStore';
import { useModelStore } from '../store/modelStore';
import { useT } from '../i18n/hooks';
import { getErrorMessage } from '../utils/errors';
import { useShallow } from 'zustand/react/shallow';
import type { AgentNode } from '../types/graph';
import { getSessionGeneration, isCurrentSession } from '../utils/authSession';
import { generateNodePosition, isGraphOperationCancelled } from '../utils/graphEditorUtils';

/**
 * 图编辑器页面
 */
const GraphEditor: React.FC = () => {
  const t = useT();
  const { modal } = App.useApp();
  const {
    fetchGraphs,
    closeGraph,
    editorSession,
    addNode,
    loading,
    error,
    currentGraph,
    selectedNode,
    selectNode,
    createNewGraph,
    deleteGraph,
    graphs,
    loadGraph,
    saveGraph,
    dirty: hasUnsavedChanges,
    exportGraph,
    generateMCPScript,
    getGraphReadme,
    updateGraphProperties,
    autoLayout,
    importGraphFromFile,
    importGraphPackageFromFile
  } = useGraphEditorStore(useShallow(state => ({
    fetchGraphs: state.fetchGraphs, closeGraph: state.closeGraph, editorSession: state.editorSession,
    addNode: state.addNode, loading: state.loading, error: state.error, currentGraph: state.currentGraph,
    selectedNode: state.selectedNode, selectNode: state.selectNode, createNewGraph: state.createNewGraph,
    deleteGraph: state.deleteGraph, graphs: state.graphs, loadGraph: state.loadGraph, saveGraph: state.saveGraph,
    dirty: state.dirty, exportGraph: state.exportGraph, generateMCPScript: state.generateMCPScript,
    getGraphReadme: state.getGraphReadme, updateGraphProperties: state.updateGraphProperties,
    autoLayout: state.autoLayout, importGraphFromFile: state.importGraphFromFile, importGraphPackageFromFile: state.importGraphPackageFromFile
  })));

  const fetchConfig = useMCPStore(state => state.fetchConfig);
  const fetchStatus = useMCPStore(state => state.fetchStatus);
  const fetchModels = useModelStore(state => state.fetchModels);

  // 状态管理
  const viewMode = currentGraph ? 'editor' : 'list';
  const [addNodeModalVisible, setAddNodeModalVisible] = useState(false);
  const [newGraphModalVisible, setNewGraphModalVisible] = useState(false);
  const [versionManagerVisible, setVersionManagerVisible] = useState(false);
  const [searchText, setSearchText] = useState('');
  const filteredGraphs = useMemo(() => graphs.filter(name => name.toLowerCase().includes(searchText.trim().toLowerCase())), [graphs, searchText]);

  const [readmeModalVisible, setReadmeModalVisible] = useState(false);
  const [readmeContent, setReadmeContent] = useState('');
  const [graphSettingsModalVisible, setGraphSettingsModalVisible] = useState(false);

  // 初始化数据
  useEffect(() => {
    const initializeData = async () => {
      try {
        await Promise.all([
          fetchGraphs(),
          fetchConfig(),
          fetchStatus(),
          fetchModels()
        ]);
      } catch (error) {
        console.error('Failed to initialize data:', error);
      }
    };

    initializeData();

    const statusInterval = setInterval(() => {
      fetchStatus();
    }, 30000);

    return () => {
      clearInterval(statusInterval);
    };
  }, [fetchGraphs, fetchConfig, fetchStatus, fetchModels]);

  // 创建新图
  const handleCreateNewGraph = async (values: { name: string; description?: string }) => {
    try {
      createNewGraph(values.name, values.description || '');
      message.success(t('pages.graphEditor.createSuccess', { name: values.name }));
    } catch (error) {
      message.error(t('pages.graphEditor.createFailed', { error: getErrorMessage(error, t('errors.serverError')) }));
      throw error;
    }
  };

  // 进入编辑模式
  const handleEditGraph = (graphName: string) => {
    void loadGraph(graphName).catch(() => {});
  };

  // 返回列表
  const handleBackToList = () => {
    if (hasUnsavedChanges) {
      modal.confirm({
        title: t('pages.graphEditor.saveChangesTitle'),
        content: t('pages.graphEditor.saveChangesMessage'),
        okText: t('pages.graphEditor.saveAndReturn'),
        cancelText: t('pages.graphEditor.returnDirectly'),
        onOk: async () => {
          await handleSave();
          if (useGraphEditorStore.getState().dirty) throw new Error(t('pages.graphEditor.saveChangesMessage'));
          closeGraph();
        },
        onCancel: () => {
          closeGraph();
        }
      });
    } else {
      closeGraph();
    }
  };

  // 删除图
  const handleDeleteGraph = async (graphName: string) => {
    const generation = getSessionGeneration();
    try {
      await deleteGraph(graphName);
      if (!isCurrentSession(generation)) return;
      message.success(t('pages.graphEditor.deleteSuccess', { name: graphName }));
    } catch (error) {
      if (!isCurrentSession(generation) || isGraphOperationCancelled(error)) return;
      message.error(t('pages.graphEditor.deleteFailed', { error: getErrorMessage(error, t('errors.serverError')) }));
    }
  };

  // 导出为压缩包
  const handleExportPackage = async (graphName: string) => {
    const generation = getSessionGeneration();
    try {
      await exportGraph(graphName);
      if (!isCurrentSession(generation)) return;
      message.success(t('pages.graphEditor.exportSuccess', { name: graphName }));
    } catch (error) {
      if (!isCurrentSession(generation) || isGraphOperationCancelled(error)) return;
      message.error(t('pages.graphEditor.exportFailed', { error: getErrorMessage(error, t('errors.serverError')) }));
    }
  };

  // 导出为 MCP Script
  const handleExportMCP = async (graphName: string) => {
    const generation = getSessionGeneration();
    try {
      await generateMCPScript(graphName);
      if (!isCurrentSession(generation)) return;
      message.success(t('pages.graphEditor.exportMCPSuccess'));
    } catch (error) {
      if (!isCurrentSession(generation) || isGraphOperationCancelled(error)) return;
      message.error(t('pages.graphEditor.exportFailed', { error: getErrorMessage(error, t('errors.serverError')) }));
    }
  };

  // 导入文件
  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const generation = getSessionGeneration();
    try {
      const fileName = file.name.toLowerCase();
      let result;

      if (fileName.endsWith('.json')) {
        result = await importGraphFromFile(file);
        if (!isCurrentSession(generation)) return;
      message.success(t('pages.graphEditor.importSuccess', { name: result.graph_name || file.name }));
      } else if (fileName.endsWith('.zip')) {
        result = await importGraphPackageFromFile(file);
        if (!isCurrentSession(generation)) return;
      message.success(t('pages.graphEditor.importPackageSuccess', { name: result.graph_name || file.name }));
      } else {
        message.error(t('pages.graphEditor.unsupportedFileType'));
        return;
      }

      event.target.value = '';
    } catch (error) {
      if (!isCurrentSession(generation) || isGraphOperationCancelled(error)) return;
      message.error(t('pages.graphEditor.importFailed', { error: getErrorMessage(error, t('errors.serverError')) }));
      event.target.value = '';
    }
  };

  // 添加节点
  const handleAddNode = (nodeData: Partial<AgentNode>) => {
    const position = generateNodePosition();
    addNode({ ...nodeData, position });
    setAddNodeModalVisible(false);
  };

  // 保存当前图
  const handleSave = async () => {
    const generation = getSessionGeneration();
    try {
      await saveGraph();
      if (!isCurrentSession(generation)) throw new DOMException('Session changed', 'AbortError');
      message.success(t('pages.graphEditor.saveSuccess'));
    } catch (error) {
      if (!isCurrentSession(generation) || isGraphOperationCancelled(error)) throw error;
      message.error(t('pages.graphEditor.saveFailed', { error: getErrorMessage(error, t('errors.serverError')) }));
      throw error;
    }
  };

  // 查看 README
  const handleViewReadme = async () => {
    if (!currentGraph) return;
    const generation = getSessionGeneration();
    try {
      const result = await getGraphReadme(currentGraph.name);
      if (!isCurrentSession(generation)) return;
      if (useGraphEditorStore.getState().editorSession !== editorSession) return;
      setReadmeContent(result.readme);
      setReadmeModalVisible(true);
    } catch (error) {
      if (!isCurrentSession(generation) || isGraphOperationCancelled(error)) return;
      message.error(t('pages.graphEditor.readmeFailed', { error: getErrorMessage(error, t('errors.serverError')) }));
    }
  };

  // 自动布局
  const handleAutoLayout = () => {
    autoLayout();
    message.success(t('pages.graphEditor.autoLayoutSuccess'));
  };

  // 更新图设置
  const handleUpdateGraphSettings = async (values: { name: string; description?: string; end_template?: string }) => {
    try {
      updateGraphProperties(values);
      message.success(t('pages.graphEditor.graphSettingsUpdated'));
    } catch (error) {
      message.error(t('pages.graphEditor.graphSettingsUpdateFailed', { error: getErrorMessage(error, t('errors.serverError')) }));
      throw error;
    }
  };

  return (
    <div>
      {error && (
        <Alert
          message={t('pages.graphEditor.error')}
          description={error}
          type="error"
          showIcon
          closable
          style={{ margin: '16px' }}
        />
      )}

      {/* 主视图 */}
      {viewMode === 'list' ? (
        <GraphListView
          loading={loading}
          graphs={graphs}
          filteredGraphs={filteredGraphs}
          searchText={searchText}
          onSearchChange={setSearchText}
          onCreateGraph={() => setNewGraphModalVisible(true)}
          onImportFile={handleImportFile}
          onEditGraph={handleEditGraph}
          onExportPackage={handleExportPackage}
          onExportMCP={handleExportMCP}
          onDeleteGraph={handleDeleteGraph}
        />
      ) : (
        <GraphEditorView
          key={editorSession}
          graphName={currentGraph?.name || ''}
          graphDescription={currentGraph?.description}
          hasUnsavedChanges={hasUnsavedChanges}
          selectedNode={selectedNode}
          onBack={handleBackToList}
          onSave={handleSave}
          onViewReadme={handleViewReadme}
          onAutoLayout={handleAutoLayout}
          onAddNode={() => setAddNodeModalVisible(true)}
          onGraphSettings={() => {
            try { useGraphEditorStore.getState().applyJsonDraft(); setGraphSettingsModalVisible(true); }
            catch (error) { message.error(getErrorMessage(error)); }
          }}
          onVersionManager={() => setVersionManagerVisible(true)}
          onCloseNodePanel={() => selectNode(null)}
        />
      )}

      {/* 模态框组件 */}
      <CreateGraphModal
        visible={newGraphModalVisible}
        onOk={handleCreateNewGraph}
        onCancel={() => setNewGraphModalVisible(false)}
      />

      <GraphSettingsModal
        visible={graphSettingsModalVisible}
        graphName={currentGraph?.name}
        description={currentGraph?.description}
        endTemplate={currentGraph?.end_template}
        onOk={handleUpdateGraphSettings}
        onCancel={() => setGraphSettingsModalVisible(false)}
      />

      <ReadmeModal
        visible={readmeModalVisible}
        content={readmeContent}
        onClose={() => setReadmeModalVisible(false)}
      />

      <AddNodeModal
        visible={addNodeModalVisible}
        onClose={() => setAddNodeModalVisible(false)}
        onAdd={handleAddNode}
      />

      {currentGraph && (
        <GraphVersionManager
          visible={versionManagerVisible}
          onClose={() => setVersionManagerVisible(false)}
          graphName={currentGraph.name}
        />
      )}
    </div>
  );
};

export default GraphEditor;
