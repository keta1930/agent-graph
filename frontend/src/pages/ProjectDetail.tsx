import { getErrorMessage } from '../utils/errors';
import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import {
  Layout,
  Typography,
  Space,
  Button,
  Card,
  Row,
  Col,
  List,
  Empty,
  Modal,
  Form,
  Input,
  App,
  Spin,
  Tag,
  Select,
  Popconfirm,
  Tooltip,
} from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, MessageSquareText, Plus, Upload, Link2, FileText, Trash2, Pencil, Check, X } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { zhCN, enUS } from 'date-fns/locale';
import { useT } from '../i18n/hooks';
import { useI18n } from '../i18n/I18nContext';
import { projectService } from '../services/projectService';
import projectFileService from '../services/projectFileService';
import conversationFileService from '../services/conversationFileService';
import { ConversationService } from '../services/conversationService';
import FileViewModal from '../components/conversation-file/FileViewModal';
import { ProjectDetail as ProjectDetailType, ProjectConversationSummary } from '../types/project';
import { ConversationSummary } from '../types/conversation';

const { Header, Content } = Layout;
const { Title, Text, Paragraph } = Typography;

// 样式常量 - 与 PromptManager 保持一致
const HEADER_STYLES = {
  container: {
    background: 'linear-gradient(to bottom, rgba(255, 255, 255, 0.8), rgba(245, 243, 240, 0.6))',
    backdropFilter: 'blur(20px)',
    padding: '0 48px',
    borderBottom: 'none',
    boxShadow: '0 2px 8px rgba(139, 115, 85, 0.08)',
    position: 'relative' as const,
  },
  decorativeLine: {
    position: 'absolute' as const,
    bottom: 0,
    left: '20%',
    right: '20%',
    height: '1px',
    background: 'linear-gradient(to right, transparent, rgba(139, 115, 85, 0.3) 50%, transparent)',
  },
  title: {
    margin: 0,
    color: '#2d2d2d',
    fontWeight: 500,
    letterSpacing: '2px',
    fontSize: '18px',
  },
};

const BUTTON_STYLES = {
  primary: {
    background: 'linear-gradient(135deg, #b85845 0%, #a0826d 100%)',
    border: 'none',
    borderRadius: '6px',
    color: '#fff',
    fontSize: '14px',
    fontWeight: 500,
    letterSpacing: '0.3px',
    boxShadow: '0 2px 6px rgba(184, 88, 69, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.2)',
    transition: 'all 0.3s cubic-bezier(0.23, 1, 0.32, 1)',
  },
  icon: {
    color: '#8b7355',
    transition: 'all 0.2s ease',
    cursor: 'pointer',
    padding: '4px',
    borderRadius: '4px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
};

const ProjectDetail: React.FC = () => {
  const t = useT();
  const latestT = useRef(t);
  latestT.current = t;
  const { locale } = useI18n();
  const dateLocale = locale === 'zh' ? zhCN : enUS;
  const { message } = App.useApp();
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const scope = useRef(0);
  const fileRequest = useRef(0);
  const projectFilesRequest = useRef(0);
  const projectFilesController = useRef<AbortController | null>(null);
  const [project, setProject] = useState<ProjectDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [projectFiles, setProjectFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [fileUploadsPending, setFileUploadsPending] = useState(0);
  const [fileModalOpen, setFileModalOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [createFileOpen, setCreateFileOpen] = useState(false);
  const [createFileLoading, setCreateFileLoading] = useState(false);
  const [createFileForm] = Form.useForm();
  const [pushFileOpen, setPushFileOpen] = useState(false);
  const [pushFileLoading, setPushFileLoading] = useState(false);
  const [pushFileForm] = Form.useForm();
  const [conversationFiles, setConversationFiles] = useState<string[]>([]);
  const [conversationFilesLoading, setConversationFilesLoading] = useState(false);
  const [loadedConversationId, setLoadedConversationId] = useState<string | null>(null);
  const [addConversationOpen, setAddConversationOpen] = useState(false);
  const [conversationSearch, setConversationSearch] = useState('');
  const [allConversations, setAllConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  
  // 项目名称编辑状态
  const [isEditingName, setIsEditingName] = useState(false);
  const [editingNameValue, setEditingNameValue] = useState('');
  
  // 项目指令编辑状态
  const [instructionModalOpen, setInstructionModalOpen] = useState(false);
  const [instructionForm] = Form.useForm();

  const loadProject = useCallback(async (signal?: AbortSignal) => {
    const owner = scope.current;
    if (!projectId) return;
    setLoading(true);
    try {
      const detail = await projectService.getProjectDetail(projectId, true, { signal });
      if (owner !== scope.current) return;
      setProject(detail);
    } catch (error) {
      if (owner !== scope.current) return;
      message.error(latestT.current('pages.projectDetail.loadFailed', { error: getErrorMessage(error) }));
    } finally {
      if (owner === scope.current) setLoading(false);
    }
  }, [projectId, message]);

  const loadProjectFiles = useCallback(async () => {
    if (!projectId) return;
    const owner = scope.current;
    const request = ++projectFilesRequest.current;
    projectFilesController.current?.abort();
    const controller = new AbortController();
    projectFilesController.current = controller;
    setFilesLoading(true);
    try {
      const response = await projectFileService.listFiles(projectId, { signal: controller.signal });
      if (owner !== scope.current || request !== projectFilesRequest.current) return;
      setProjectFiles(response.files);
    } catch (error) {
      if (owner !== scope.current || request !== projectFilesRequest.current) return;
      message.error(latestT.current('pages.projectDetail.filesLoadFailed', { error: getErrorMessage(error) }));
    } finally {
      if (owner === scope.current && request === projectFilesRequest.current) setFilesLoading(false);
    }
  }, [projectId, message]);

  const loadAllConversations = async () => {
    const owner = scope.current;
    setConversationsLoading(true);
    try {
      const response = await ConversationService.getConversations();
      if (owner !== scope.current) return;
      setAllConversations(response.conversations || []);
    } catch (error) {
      if (owner !== scope.current) return;
      message.error(t('pages.projectDetail.conversationsLoadFailed', { error: getErrorMessage(error) }));
    } finally {
      if (owner === scope.current) setConversationsLoading(false);
    }
  };

  useEffect(() => {
    scope.current += 1;
    const controller = new AbortController();
    setProject(null);
    setProjectFiles([]);
    setFilesLoading(false);
    setFileUploadsPending(0);
    setCreateFileLoading(false);
    setPushFileLoading(false);
    setConversationFilesLoading(false);
    setConversationsLoading(false);
    setLoadedConversationId(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setFileModalOpen(false);
    setCreateFileOpen(false);
    setPushFileOpen(false);
    setInstructionModalOpen(false);
    setIsEditingName(false);
    setAddConversationOpen(false);
    setAllConversations([]);
    setConversationFiles([]);
    void loadProject(controller.signal);
    void loadProjectFiles();
    return () => {
      scope.current += 1;
      fileRequest.current += 1;
      projectFilesRequest.current += 1;
      controller.abort();
      projectFilesController.current?.abort();
    };
  }, [loadProject, loadProjectFiles]);
  useEffect(() => { fileRequest.current += 1; }, [pushFileOpen]);

  // 开始编辑项目名称
  const startEditingName = () => {
    if (project) {
      setEditingNameValue(project.name);
      setIsEditingName(true);
    }
  };

  // 保存项目名称
  const saveProjectName = async () => {
    const owner = scope.current;
    if (!project || !editingNameValue.trim()) return;
    try {
      await projectService.updateProject(project.project_id, {
        name: editingNameValue.trim(),
        instruction: project.instruction,
      });
      if (owner !== scope.current) return;
      message.success(t('pages.projects.updateSuccess', { name: editingNameValue.trim() }));
      setIsEditingName(false);
      loadProject();
    } catch (error) {
      if (owner !== scope.current) return;
      message.error(t('pages.projects.saveFailed', { error: getErrorMessage(error) }));
    }
  };

  // 取消编辑项目名称
  const cancelEditingName = () => {
    setIsEditingName(false);
    setEditingNameValue('');
  };

  // 打开指令编辑弹窗
  const openInstructionModal = () => {
    if (project) {
      instructionForm.setFieldsValue({ instruction: project.instruction || '' });
      setInstructionModalOpen(true);
    }
  };

  // 保存项目指令
  const saveInstruction = async () => {
    const owner = scope.current;
    if (!project) return;
    try {
      const values = await instructionForm.validateFields();
      if (owner !== scope.current) return;
      await projectService.updateProject(project.project_id, {
        name: project.name,
        instruction: values.instruction,
      });
      if (owner !== scope.current) return;
      message.success(t('pages.projects.updateSuccess', { name: project.name }));
      setInstructionModalOpen(false);
      loadProject();
    } catch (error) {
      if (owner !== scope.current) return;
      if (error && typeof error === 'object' && 'errorFields' in error) return;
      message.error(t('pages.projects.saveFailed', { error: getErrorMessage(error) }));
    }
  };

  const openAddConversationModal = async () => {
    const owner = scope.current;
    setAddConversationOpen(true);
    setConversationSearch('');
    if (allConversations.length === 0) {
      await loadAllConversations();
      if (owner !== scope.current) return;
    }
  };

  const handleAddConversation = async (conversationId: string) => {
    const owner = scope.current;
    if (!project) return;
    try {
      await projectService.moveConversationToProject(conversationId, project.project_id);
      if (owner !== scope.current) return;
      message.success(t('pages.projectDetail.conversationAdded'));
      await loadProject();
      if (owner !== scope.current) return;
      await loadAllConversations();
      if (owner !== scope.current) return;
    } catch (error) {
      if (owner !== scope.current) return;
      message.error(t('pages.projectDetail.conversationAddFailed', { error: getErrorMessage(error) }));
    }
  };

  const handleRemoveConversation = async (conversationId: string) => {
    const owner = scope.current;
    if (!project) return;
    try {
      await projectService.moveConversationToProject(conversationId, null);
      if (owner !== scope.current) return;
      message.success(t('pages.projectDetail.conversationRemoved'));
      await loadProject();
      if (owner !== scope.current) return;
      await loadAllConversations();
      if (owner !== scope.current) return;
    } catch (error) {
      if (owner !== scope.current) return;
      message.error(t('pages.projectDetail.conversationRemoveFailed', { error: getErrorMessage(error) }));
    }
  };

  const openCreateFileModal = () => {
    createFileForm.resetFields();
    setCreateFileOpen(true);
  };

  const handleCreateFile = async () => {
    const owner = scope.current;
    if (!projectId) return;
    try {
      const values = await createFileForm.validateFields();
      if (owner !== scope.current) return;
      setCreateFileLoading(true);
      await projectFileService.createFile(projectId, {
        filename: values.filename,
        summary: values.summary || '',
        content: values.content || '',
        log: values.log || t('pages.projectDetail.fileCreateLog'),
      });
      if (owner !== scope.current) return;
      message.success(t('pages.projectDetail.fileCreateSuccess'));
      setCreateFileOpen(false);
      loadProjectFiles();
    } catch (error) {
      if (owner !== scope.current) return;
      if (error && typeof error === 'object' && 'errorFields' in error) return;
      message.error(t('pages.projectDetail.fileCreateFailed', { error: getErrorMessage(error) }));
    } finally {
      if (owner === scope.current) setCreateFileLoading(false);
    }
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleUploadFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const owner = scope.current;
    if (!projectId) return;
    const files = event.target.files ? Array.from(event.target.files) : [];
    if (files.length === 0) return;
    setFileUploadsPending(count => count + 1);
    try {
      await Promise.all(files.map((file) => projectFileService.uploadFile(projectId, file)));
      if (owner !== scope.current) return;
      message.success(t('pages.projectDetail.fileUploadSuccess', { count: files.length }));
      loadProjectFiles();
    } catch (error) {
      if (owner !== scope.current) return;
      message.error(t('pages.projectDetail.fileUploadFailed', { error: getErrorMessage(error) }));
    } finally {
      if (owner === scope.current) {
        setFileUploadsPending(count => count - 1);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    }
  };

  const handleOpenFile = (filename: string) => {
    setSelectedFile(filename);
    setFileModalOpen(true);
  };

  const handleDeleteFile = async (filename: string) => {
    const owner = scope.current;
    if (!projectId) return;
    try {
      await projectFileService.deleteFile(projectId, filename);
      if (owner !== scope.current) return;
      message.success(t('pages.projectDetail.fileDeleteSuccess'));
      loadProjectFiles();
    } catch (error) {
      if (owner !== scope.current) return;
      message.error(t('pages.projectDetail.fileDeleteFailed', { error: getErrorMessage(error) }));
    }
  };

  const openPushFileModal = async () => {
    const owner = scope.current;
    pushFileForm.resetFields();
    setConversationFiles([]);
    setLoadedConversationId(null);
    setConversationFilesLoading(false);
    setPushFileOpen(true);
    if (allConversations.length === 0) {
      await loadAllConversations();
      if (owner !== scope.current) return;
    }
  };

  const handleConversationSelect = async (conversationId: string) => {
    const fileOwner = ++fileRequest.current;
    const owner = scope.current;
    pushFileForm.setFieldsValue({ filename: undefined });
    setConversationFiles([]);
    setLoadedConversationId(null);
    setConversationFilesLoading(true);
    try {
      const response = await conversationFileService.listFiles(conversationId);
      if (owner !== scope.current) return;
      if (fileOwner !== fileRequest.current) return;
      setConversationFiles(response.files || []);
      setLoadedConversationId(conversationId);
    } catch (error) {
      if (owner !== scope.current) return;
      if (fileOwner !== fileRequest.current) return;
      message.error(t('pages.projectDetail.fileLoadConversationFailed', { error: getErrorMessage(error) }));
    } finally {
      if (owner === scope.current && fileOwner === fileRequest.current) setConversationFilesLoading(false);
    }
  };

  const handlePushFile = async () => {
    const owner = scope.current;
    const fileOwner = fileRequest.current;
    if (!projectId || conversationFilesLoading || !loadedConversationId) return;
    try {
      const values = await pushFileForm.validateFields();
      if (owner !== scope.current || fileOwner !== fileRequest.current) return;
      if (values.conversationId !== loadedConversationId || !conversationFiles.includes(values.filename)) return;
      setPushFileLoading(true);
      await projectFileService.pushFileFromConversation(projectId, {
        conversation_id: values.conversationId,
        filename: values.filename,
      });
      if (owner !== scope.current) return;
      message.success(t('pages.projectDetail.filePushSuccess'));
      setPushFileOpen(false);
      loadProjectFiles();
    } catch (error) {
      if (owner !== scope.current) return;
      if (error && typeof error === 'object' && 'errorFields' in error) return;
      message.error(t('pages.projectDetail.filePushFailed', { error: getErrorMessage(error) }));
    } finally {
      if (owner === scope.current) setPushFileLoading(false);
    }
  };

  const conversations = useMemo<ProjectConversationSummary[]>(() => {
    return project?.conversations || [];
  }, [project]);

  const availableConversations = useMemo(() => {
    const keyword = conversationSearch.trim().toLowerCase();
    const projectConversationIds = new Set(conversations.map((item) => item.conversation_id));
    return allConversations
      .filter((conv) => !projectConversationIds.has(conv.conversation_id))
      .filter((conv) => (keyword ? conv.title.toLowerCase().includes(keyword) : true));
  }, [allConversations, conversations, conversationSearch]);

  const renderTimeAgo = (value?: string) => {
    if (!value) return t('pages.projectDetail.updatedUnknown');
    return formatDistanceToNow(new Date(value), { addSuffix: true, locale: dateLocale });
  };

  return (
    <Layout style={{ height: '100vh', background: '#faf8f5', display: 'flex', flexDirection: 'column' }}>
      <Header style={HEADER_STYLES.container}>
        <div style={HEADER_STYLES.decorativeLine} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: '100%' }}>
          <Space size="middle">
            <Button
              type="text"
              icon={<ArrowLeft size={16} strokeWidth={1.5} />}
              onClick={() => navigate('/workspace/projects')}
              style={{ color: '#8b7355' }}
            >
              {t('pages.projectDetail.back')}
            </Button>
            {isEditingName ? (
              <Space size={8}>
                <Input
                  value={editingNameValue}
                  onChange={(e) => setEditingNameValue(e.target.value)}
                  onPressEnter={saveProjectName}
                  style={{ width: 200, height: 32 }}
                  autoFocus
                />
                <Button
                  type="text"
                  icon={<Check size={16} strokeWidth={1.5} />}
                  onClick={saveProjectName}
                  style={{ color: '#52c41a', padding: '4px' }}
                />
                <Button
                  type="text"
                  icon={<X size={16} strokeWidth={1.5} />}
                  onClick={cancelEditingName}
                  style={{ color: '#8b7355', padding: '4px' }}
                />
              </Space>
            ) : (
              <Space size={8}>
                <Title level={4} style={HEADER_STYLES.title}>
                  {project?.name || t('pages.projectDetail.title')}
                </Title>
                <Tooltip title={t('pages.projectDetail.editName')}>
                  <Button
                    type="text"
                    icon={<Pencil size={14} strokeWidth={1.5} />}
                    onClick={startEditingName}
                    style={BUTTON_STYLES.icon}
                  />
                </Tooltip>
              </Space>
            )}
          </Space>
        </div>
      </Header>

      <Content style={{ padding: '24px 48px 40px', overflow: 'auto' }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
            <Spin size="large" />
          </div>
        ) : !project ? (
          <Empty description={t('pages.projectDetail.notFound')} style={{ marginTop: '80px' }} />
        ) : (
          <Row gutter={[20, 20]} align="stretch">
            <Col xs={24} lg={15} xl={16} style={{ display: 'flex', flexDirection: 'column' }}>
              <Card
                style={{
                  borderRadius: '6px',
                  border: '1px solid rgba(139, 115, 85, 0.15)',
                  background: 'rgba(255, 255, 255, 0.85)',
                  boxShadow: '0 1px 3px rgba(139, 115, 85, 0.06)',
                  maxHeight: '620px',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                }}
                bodyStyle={{ padding: '20px', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <Space align="center">
                    <MessageSquareText size={18} color="#b85845" strokeWidth={1.5} />
                    <Title level={5} style={{ margin: 0, fontSize: '15px' }}>
                      {t('pages.projectDetail.conversations')}
                    </Title>
                  </Space>
                  <Button
                    type="primary"
                    icon={<Plus size={14} strokeWidth={1.5} />}
                    onClick={openAddConversationModal}
                    style={BUTTON_STYLES.primary}
                  >
                    {t('pages.projectDetail.addConversation')}
                  </Button>
                </div>

                <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: 'rgba(139, 115, 85, 0.3) transparent' }}>
                {conversations.length === 0 ? (
                  <Empty description={t('pages.projectDetail.noConversations')} />
                ) : (
                  <List
                    itemLayout="horizontal"
                    dataSource={conversations}
                    renderItem={(item) => (
                      <List.Item
                        style={{
                          padding: '10px 8px',
                          cursor: 'pointer',
                          borderRadius: '8px',
                          transition: 'all 0.2s ease',
                        }}
                        onClick={() => navigate(`/chat/${item.conversation_id}`)}
                        actions={[
                          <Button
                            key="remove"
                            type="text"
                            icon={<Trash2 size={14} />}
                            onClick={(event) => {
                              event.stopPropagation();
                              handleRemoveConversation(item.conversation_id);
                            }}
                            style={{ color: '#b85845', fontSize: '13px' }}
                          >
                            {t('pages.projectDetail.removeConversation')}
                          </Button>,
                        ]}
                      >
                        <List.Item.Meta
                          title={
                            <Text style={{ color: '#2d2d2d', fontWeight: 500, fontSize: '14px' }}>
                              {item.title || item.conversation_id}
                            </Text>
                          }
                          description={
                            <Text style={{ color: 'rgba(45, 24, 16, 0.65)', fontSize: '12px' }}>
                              {t('pages.projectDetail.updatedAt', {
                                time: renderTimeAgo(item.updated_at || item.created_at),
                              })}
                            </Text>
                          }
                        />
                        <Text style={{ color: 'rgba(45, 24, 16, 0.45)', fontSize: '12px' }}>
                          {item.conversation_id.slice(-6)}
                        </Text>
                      </List.Item>
                    )}
                  />
                )}
                </div>
              </Card>
            </Col>

            <Col xs={24} lg={9} xl={8} style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', flex: 1, maxHeight: '600px' }}>
                <Card
                  style={{
                    borderRadius: '6px',
                    border: '1px solid rgba(139, 115, 85, 0.15)',
                    background: 'rgba(255, 255, 255, 0.85)',
                    boxShadow: '0 1px 3px rgba(139, 115, 85, 0.06)',
                    flex: '0 0 calc(35% - 8px)',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                  }}
                  bodyStyle={{ padding: '16px', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <Text style={{ fontWeight: 600, color: '#2d2d2d', fontSize: '14px' }}>
                      {t('pages.projectDetail.instructions')}
                    </Text>
                    <Tooltip title={t('pages.projectDetail.setInstructions')}>
                      <Button
                        type="text"
                        icon={<Pencil size={14} strokeWidth={1.5} />}
                        onClick={openInstructionModal}
                        style={BUTTON_STYLES.icon}
                      />
                    </Tooltip>
                  </div>
                  <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: 'rgba(139, 115, 85, 0.3) transparent' }}>
                  {project.instruction ? (
                    <Paragraph style={{ color: 'rgba(45, 24, 16, 0.75)', whiteSpace: 'pre-wrap', marginBottom: 0, fontSize: '13px' }}>
                      {project.instruction}
                    </Paragraph>
                  ) : (
                    <Empty description={t('pages.projectDetail.noInstructions')} />
                  )}
                  </div>
                </Card>

                <Card
                  style={{
                    borderRadius: '6px',
                    border: '1px solid rgba(139, 115, 85, 0.15)',
                    background: 'rgba(255, 255, 255, 0.85)',
                    boxShadow: '0 1px 3px rgba(139, 115, 85, 0.06)',
                    flex: '0 0 calc(65% - 8px)',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                  }}
                  bodyStyle={{ padding: '16px', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <Space align="center">
                      <Text style={{ fontWeight: 600, color: '#2d2d2d', fontSize: '14px' }}>
                        {t('pages.projectDetail.files')}
                      </Text>
                      <Tag style={{
                        background: 'rgba(184, 88, 69, 0.08)',
                        color: '#b85845',
                        border: '1px solid rgba(184, 88, 69, 0.25)',
                        borderRadius: '6px',
                        fontSize: '12px',
                      }}>{projectFiles.length}</Tag>
                    </Space>
                    <Space size={4}>
                      <Button
                        type="text"
                        icon={<FileText size={14} strokeWidth={1.5} />}
                        onClick={openCreateFileModal}
                        style={{ color: '#b85845', padding: '4px 8px', fontSize: '13px' }}
                      >
                        {t('pages.projectDetail.newFile')}
                      </Button>
                      <Button
                        type="text"
                        icon={<Upload size={14} strokeWidth={1.5} />}
                        onClick={handleUploadClick}
                        style={{ color: '#b85845', padding: '4px 8px', fontSize: '13px' }}
                      >
                        {t('pages.projectDetail.uploadFile')}
                      </Button>
                      <Button
                        type="text"
                        icon={<Link2 size={14} strokeWidth={1.5} />}
                        onClick={openPushFileModal}
                        style={{ color: '#b85845', padding: '4px 8px', fontSize: '13px' }}
                      >
                        {t('pages.projectDetail.pushFile')}
                      </Button>
                      <input
                        type="file"
                        ref={fileInputRef}
                        style={{ display: 'none' }}
                        multiple
                        onChange={handleUploadFiles}
                      />
                    </Space>
                  </div>
                  <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: 'rgba(139, 115, 85, 0.3) transparent' }}>
                  {filesLoading || fileUploadsPending > 0 ? (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0' }}>
                      <Spin />
                    </div>
                  ) : projectFiles.length > 0 ? (
                    <List
                      size="small"
                      dataSource={projectFiles}
                      renderItem={(file) => (
                        <List.Item
                          style={{
                            padding: '8px 0',
                            borderBottom: '1px solid rgba(139, 115, 85, 0.08)',
                          }}
                          actions={[
                            <Button
                              key="open"
                              type="link"
                              onClick={() => handleOpenFile(file)}
                              style={{ padding: 0, color: '#b85845' }}
                            >
                              {t('pages.projectDetail.openFile')}
                            </Button>,
                            <Popconfirm
                              key="delete"
                              title={t('pages.projectDetail.fileDeleteConfirmTitle')}
                              description={t('pages.projectDetail.fileDeleteConfirmMessage', { filename: file })}
                              onConfirm={() => handleDeleteFile(file)}
                              okText={t('common.delete')}
                              cancelText={t('common.cancel')}
                              okButtonProps={{ style: { background: '#b85845', borderColor: '#b85845' } }}
                            >
                              <Button type="link" style={{ padding: 0, color: '#b85845' }}>
                                {t('common.delete')}
                              </Button>
                            </Popconfirm>,
                          ]}
                        >
                          <Text style={{ color: 'rgba(45, 24, 16, 0.75)' }}>{file}</Text>
                        </List.Item>
                      )}
                    />
                  ) : (
                    <Empty description={t('pages.projectDetail.noFiles')} />
                  )}
                  </div>
                </Card>
              </div>
            </Col>
          </Row>
        )}
      </Content>

      <Modal
        open={instructionModalOpen}
        title={t('pages.projectDetail.setInstructions')}
        onCancel={() => setInstructionModalOpen(false)}
        onOk={saveInstruction}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        okButtonProps={{
          style: BUTTON_STYLES.primary,
        }}
        centered
      >
        <Form form={instructionForm} layout="vertical">
          <Form.Item name="instruction" label={t('pages.projects.instructionLabel')}>
            <Input.TextArea rows={8} placeholder={t('pages.projects.instructionPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={addConversationOpen}
        title={t('pages.projectDetail.addConversationTitle')}
        onCancel={() => setAddConversationOpen(false)}
        footer={null}
        centered
      >
        <Input
          placeholder={t('pages.projectDetail.searchConversations')}
          value={conversationSearch}
          onChange={(event) => setConversationSearch(event.target.value)}
          style={{ marginBottom: '16px' }}
        />
        {conversationsLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '20px 0' }}>
            <Spin />
          </div>
        ) : availableConversations.length === 0 ? (
          <Empty description={t('pages.projectDetail.noAvailableConversations')} />
        ) : (
          <List
            dataSource={availableConversations}
            renderItem={(item) => (
              <List.Item
                actions={[
                  <Button
                    key="add"
                    type="primary"
                    onClick={() => handleAddConversation(item.conversation_id)}
                    style={BUTTON_STYLES.primary}
                  >
                    {t('pages.projectDetail.add')}
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={<Text style={{ color: '#2d2d2d' }}>{item.title || item.conversation_id}</Text>}
                  description={<Text style={{ color: 'rgba(45, 24, 16, 0.65)' }}>{item.conversation_id}</Text>}
                />
              </List.Item>
            )}
          />
        )}
      </Modal>

      <Modal
        open={createFileOpen}
        title={t('pages.projectDetail.createFileTitle')}
        onCancel={() => setCreateFileOpen(false)}
        onOk={handleCreateFile}
        okText={t('common.create')}
        cancelText={t('common.cancel')}
        confirmLoading={createFileLoading}
        okButtonProps={{
          style: BUTTON_STYLES.primary,
        }}
        centered
      >
        <Form form={createFileForm} layout="vertical">
          <Form.Item
            name="filename"
            label={t('pages.projectDetail.fileNameLabel')}
            rules={[{ required: true, message: t('pages.projectDetail.fileNameRequired') }]}
          >
            <Input placeholder={t('pages.projectDetail.fileNamePlaceholder')} />
          </Form.Item>
          <Form.Item name="summary" label={t('pages.projectDetail.fileSummaryLabel')}>
            <Input placeholder={t('pages.projectDetail.fileSummaryPlaceholder')} />
          </Form.Item>
          <Form.Item name="content" label={t('pages.projectDetail.fileContentLabel')}>
            <Input.TextArea rows={6} placeholder={t('pages.projectDetail.fileContentPlaceholder')} />
          </Form.Item>
          <Form.Item name="log" label={t('pages.projectDetail.fileLogLabel')}>
            <Input placeholder={t('pages.projectDetail.fileLogPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={pushFileOpen}
        title={t('pages.projectDetail.pushFileTitle')}
        onCancel={() => setPushFileOpen(false)}
        onOk={handlePushFile}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        confirmLoading={pushFileLoading}
        okButtonProps={{
          disabled: conversationFilesLoading || !loadedConversationId,
          style: BUTTON_STYLES.primary,
        }}
        centered
      >
        <Form form={pushFileForm} layout="vertical">
          <Form.Item
            name="conversationId"
            label={t('pages.projectDetail.selectConversation')}
            rules={[{ required: true, message: t('pages.projectDetail.selectConversationRequired') }]}
          >
            <Select
              showSearch
              placeholder={t('pages.projectDetail.selectConversationPlaceholder')}
              options={allConversations.map((conv) => ({
                label: conv.title || conv.conversation_id,
                value: conv.conversation_id,
              }))}
              onChange={handleConversationSelect}
              filterOption={(input, option) =>
                (option?.label as string).toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>
          <Form.Item
            name="filename"
            label={t('pages.projectDetail.selectFile')}
            rules={[{ required: true, message: t('pages.projectDetail.selectFileRequired') }]}
          >
            <Select
              placeholder={t('pages.projectDetail.selectFilePlaceholder')}
              loading={conversationFilesLoading}
              options={conversationFiles.map((file) => ({ label: file, value: file }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {projectId && (
        <FileViewModal
          visible={fileModalOpen}
          filename={selectedFile}
          resourceId={projectId}
          onClose={() => {
            setFileModalOpen(false);
            setSelectedFile(null);
          }}
          onSave={loadProjectFiles}
          onDelete={loadProjectFiles}
          fileService={projectFileService}
          allowDownload={false}
        />
      )}
    </Layout>
  );
};

export default ProjectDetail;
