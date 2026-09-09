import { getErrorMessage } from '../../utils/errors';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Modal, Button, Space, Typography, message, Spin, App, Popconfirm } from 'antd';
import {
  Save,
  Download,
  Trash2,
  History,
  FileText,
} from 'lucide-react';
import conversationFileService from '../../services/conversationFileService';
import FileEditor from './FileEditor';
import MarkdownPreview from './MarkdownPreview';
import FileVersionHistory from './FileVersionHistory';
import {
  FileDetail,
  FileDetailResponse,
  FileOperationResponse,
  FileVersionResponse,
  DeleteFileResponse,
  SaveFileRequest,
} from '../../types/conversationFile';
import { isMarkdownFile, downloadBlob } from '../../utils/fileUtils';
import { useT } from '../../i18n/hooks';

const { Text } = Typography;

interface FileViewModalProps {
  visible: boolean;
  filename: string | null;
  resourceId: string;
  onClose: () => void;
  onSave?: () => void;
  onDelete?: () => void;
  fileService?: {
    getFile: (resourceId: string, filename: string, options?: { signal?: AbortSignal }) => Promise<FileDetailResponse>;
    updateFile: (resourceId: string, filename: string, data: SaveFileRequest) => Promise<FileOperationResponse>;
    deleteFile: (resourceId: string, filename: string) => Promise<DeleteFileResponse>;
    getFileVersion: (resourceId: string, filename: string, versionId: string, options?: { signal?: AbortSignal }) => Promise<FileVersionResponse>;
    downloadFile?: (resourceId: string, filename: string) => Promise<Blob>;
  };
  allowDownload?: boolean;
}

export const FileViewModal: React.FC<FileViewModalProps> = ({
  visible,
  filename,
  resourceId,
  onClose,
  onSave,
  onDelete,
  fileService,
  allowDownload = true,
}) => {
  const t = useT();
  const latestT = useRef(t);
  latestT.current = t;
  const { modal } = App.useApp();
  const [fileDetail, setFileDetail] = useState<FileDetail | null>(null);
  const [content, setContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const isDirty = content !== originalContent;
  const scope = useRef(0);
  const pendingSave = useRef(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeView, setActiveView] = useState<'editor' | 'history'>('editor');
  const service = fileService || conversationFileService;
  const canDownload = allowDownload && typeof service.downloadFile === 'function';

  const loadFile = useCallback(async (signal?: AbortSignal) => {
    if (!visible || !filename) return;
    const owner = scope.current;
    setLoading(true);
    try {
      const response = await service.getFile(resourceId, filename, { signal });
      if (owner !== scope.current || signal?.aborted) return;
      setFileDetail(response.file);
      setContent(response.file.content);
      setOriginalContent(response.file.content);
    } catch (error) {
      if (owner === scope.current && !signal?.aborted) message.error(latestT.current('pages.fileManager.fileViewModal.loadFailed', { error: getErrorMessage(error) }));
    } finally {
      if (owner === scope.current && !signal?.aborted) setLoading(false);
    }
  }, [visible, filename, resourceId, service]);

  useEffect(() => {
    scope.current += 1;
    const controller = new AbortController();
    setContent('');
    setOriginalContent('');
    setFileDetail(null);
    setActiveView('editor');
    setSaving(false);
    pendingSave.current = false;
    void loadFile(controller.signal);
    return () => { scope.current += 1; controller.abort(); };
  }, [loadFile]);

  const handleContentChange = (value: string) => setContent(value);

  const handleSave = async () => {
    if (!filename || pendingSave.current) return;
    pendingSave.current = true;
    const owner = scope.current;
    const savedContent = content;
    setSaving(true);
    try {
      await service.updateFile(resourceId, filename, {
        content: savedContent,
        summary: fileDetail?.summary || '',
        log: t('pages.fileManager.fileViewModal.saveLog'),
      });
      if (owner !== scope.current) return;
      setOriginalContent(savedContent);
      message.success(t('pages.fileManager.fileViewModal.saveSuccess'));
      onSave?.();
      // 刷新版本元数据时保留保存期间的新编辑。
      try {
        const response = await service.getFile(resourceId, filename);
        if (owner === scope.current) setFileDetail(response.file);
      } catch (error) {
        if (owner === scope.current) message.error(t('pages.fileManager.fileViewModal.loadFailed', { error: getErrorMessage(error) }));
      }
    } catch (error) {
      if (owner === scope.current) message.error(t('pages.fileManager.fileViewModal.saveFailed', { error: getErrorMessage(error) }));
    } finally {
      if (owner === scope.current) { pendingSave.current = false; setSaving(false); }
    }
  };

  const handleDownload = async () => {
    if (!filename || !service.downloadFile) return;
    const owner = scope.current;
    try {
      const blob = await service.downloadFile(resourceId, filename);
      if (owner !== scope.current) return;
      downloadBlob(blob, filename.split('/').pop() || filename);
      message.success(t('pages.fileManager.downloadSuccess'));
    } catch (error) {
      if (owner !== scope.current) return;
      message.error(t('pages.fileManager.downloadFailed', { error: getErrorMessage(error) }));
    }
  };

  const handleDeleteConfirm = async () => {
    if (!filename) return;
    const owner = scope.current;
    try {
      await service.deleteFile(resourceId, filename);
      if (owner !== scope.current) return;
      message.success(t('pages.fileManager.fileViewModal.deleteSuccess'));
      if (onDelete) onDelete();
      scope.current += 1;
      onClose();
    } catch (error) {
      if (owner !== scope.current) return;
      message.error(t('pages.fileManager.fileViewModal.deleteFailed', { error: getErrorMessage(error) }));
    }
  };

  const handleClose = () => {
    if (isDirty) {
      modal.confirm({
        title: t('pages.fileManager.fileViewModal.unsavedChangesTitle'),
        content: t('pages.fileManager.fileViewModal.unsavedChangesMessage'),
        okText: t('pages.fileManager.fileViewModal.unsavedChangesOk'),
        okType: 'danger',
        cancelText: t('pages.fileManager.fileViewModal.unsavedChangesCancel'),
        onOk: () => {
          scope.current += 1;
          setContent('');
          setOriginalContent('');
          setFileDetail(null);
          onClose();
        },
      });
    } else {
      scope.current += 1;
      setContent('');
      setOriginalContent('');
      setFileDetail(null);
      onClose();
    }
  };

  return (
    <Modal
      title={
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%'
        }}>
          <Space size="middle">
            <FileText size={20} style={{ color: '#b85845' }} />
            <Text strong style={{ fontSize: '16px', letterSpacing: '1px' }}>{filename}</Text>
            {isDirty && <Text style={{ color: '#d4a574', fontSize: '16px' }}>●</Text>}
          </Space>
          <Space size="small">
            <Button
              type={activeView === 'editor' ? 'primary' : 'default'}
              size="small"
              icon={<FileText size={14} />}
              onClick={() => setActiveView('editor')}
              style={{
                borderRadius: '6px',
                height: '32px',
                fontWeight: 500,
                letterSpacing: '0.5px',
                ...(activeView === 'editor' ? {
                  background: 'linear-gradient(135deg, #b85845 0%, #a0826d 100%)',
                  border: 'none',
                  color: '#fff'
                } : {
                  border: '1px solid rgba(139, 115, 85, 0.25)',
                  color: '#8b7355',
                  background: 'transparent'
                })
              }}
            >
              {t('pages.fileManager.fileViewModal.editor')}
            </Button>
            <Button
              type={activeView === 'history' ? 'primary' : 'default'}
              size="small"
              icon={<History size={14} />}
              onClick={() => setActiveView('history')}
              style={{
                borderRadius: '6px',
                height: '32px',
                fontWeight: 500,
                letterSpacing: '0.5px',
                ...(activeView === 'history' ? {
                  background: 'linear-gradient(135deg, #b85845 0%, #a0826d 100%)',
                  border: 'none',
                  color: '#fff'
                } : {
                  border: '1px solid rgba(139, 115, 85, 0.25)',
                  color: '#8b7355',
                  background: 'transparent'
                })
              }}
            >
              {t('pages.fileManager.fileViewModal.versionHistory')}
            </Button>
          </Space>
        </div>
      }
      open={visible}
      onCancel={handleClose}
      width="92%"
      style={{
        top: 20,
        paddingBottom: 0
      }}
      styles={{
        header: {
          background: 'transparent',
          borderBottom: '1px solid rgba(139, 115, 85, 0.15)',
          padding: '24px 32px'
        },
        body: {
          padding: 0,
          background: 'rgba(250, 248, 245, 0.3)',
          overflow: 'hidden'
        },
        footer: {
          borderTop: '1px solid rgba(139, 115, 85, 0.15)',
          padding: '20px 32px',
          background: 'rgba(250, 248, 245, 0.5)'
        }
      }}
      footer={
        <Space size="middle">
          <Button
            onClick={handleClose}
            style={{
              borderRadius: '6px',
              border: '1px solid rgba(139, 115, 85, 0.25)',
              color: '#8b7355',
              fontWeight: 500,
              letterSpacing: '0.5px'
            }}
          >
            {t('pages.fileManager.fileViewModal.close')}
          </Button>
          {canDownload && (
            <Button
              icon={<Download size={16} />}
              onClick={handleDownload}
              style={{
                borderRadius: '6px',
                border: '1px solid rgba(139, 115, 85, 0.25)',
                color: '#8b7355',
                fontWeight: 500,
                letterSpacing: '0.5px'
              }}
            >
              {t('pages.fileManager.fileViewModal.download')}
            </Button>
          )}
          <Popconfirm
            title={t('pages.fileManager.fileViewModal.deleteConfirmTitle')}
            description={t('pages.fileManager.fileViewModal.deleteConfirmMessage', { filename: filename || '' })}
            onConfirm={handleDeleteConfirm}
            okText={t('pages.fileManager.fileViewModal.deleteConfirmOk')}
            cancelText={t('pages.fileManager.fileViewModal.deleteConfirmCancel')}
            okButtonProps={{
              style: {
                background: 'linear-gradient(135deg, #b85845 0%, #a0826d 100%)',
                border: 'none',
                borderRadius: '6px',
                color: '#fff',
                fontWeight: 500,
                boxShadow: '0 2px 6px rgba(184, 88, 69, 0.25)'
              }
            }}
            cancelButtonProps={{
              style: {
                borderRadius: '6px',
                border: '1px solid rgba(139, 115, 85, 0.2)',
                color: '#8b7355',
                fontWeight: 500
              }
            }}
            overlayStyle={{
              borderRadius: '8px',
              boxShadow: '0 4px 12px rgba(139, 115, 85, 0.2)'
            }}
          >
            <Button
              icon={<Trash2 size={16} />}
              danger
              style={{
                borderRadius: '6px',
                fontWeight: 500,
                letterSpacing: '0.5px'
              }}
            >
              {t('pages.fileManager.fileViewModal.delete')}
            </Button>
          </Popconfirm>
          <Button
            type="primary"
            icon={<Save size={16} />}
            onClick={handleSave}
            disabled={!isDirty}
            loading={saving}
            style={{
              background: isDirty ? 'linear-gradient(135deg, #b85845 0%, #a0826d 100%)' : undefined,
              border: 'none',
              borderRadius: '6px',
              boxShadow: isDirty ? '0 2px 8px rgba(184, 88, 69, 0.25)' : undefined,
              fontWeight: 500,
              letterSpacing: '0.5px'
            }}
          >
            {t('pages.fileManager.fileViewModal.save')}
          </Button>
        </Space>
      }
    >
      {loading ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            height: '60vh',
          }}
        >
          <Spin size="large" tip={t('pages.fileManager.fileViewModal.loadingFile')} />
        </div>
      ) : fileDetail ? (
        <>
          <div style={{
            marginBottom: '24px',
            padding: '20px 24px',
            background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.9) 0%, rgba(250, 248, 245, 0.85) 100%)',
            border: '1px solid rgba(139, 115, 85, 0.15)',
            borderRadius: '8px',
            boxShadow: '0 1px 4px rgba(139, 115, 85, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.7)'
          }}>
            <Space split={<span style={{ color: 'rgba(139, 115, 85, 0.3)', margin: '0 12px' }}>|</span>}>
              <Text type="secondary" style={{
                fontSize: '13px',
                color: 'rgba(45, 45, 45, 0.75)',
                letterSpacing: '0.3px'
              }}>
                <strong style={{ fontWeight: 600, color: '#8b7355' }}>{t('pages.fileManager.fileViewModal.path')}:</strong> {fileDetail.filename}
              </Text>
              <Text type="secondary" style={{
                fontSize: '13px',
                color: 'rgba(45, 45, 45, 0.75)',
                letterSpacing: '0.3px'
              }}>
                <strong style={{ fontWeight: 600, color: '#8b7355' }}>{t('pages.fileManager.fileViewModal.description')}:</strong> {fileDetail.summary}
              </Text>
              <Text type="secondary" style={{
                fontSize: '13px',
                color: 'rgba(45, 45, 45, 0.75)',
                letterSpacing: '0.3px'
              }}>
                <strong style={{ fontWeight: 600, color: '#8b7355' }}>{t('pages.fileManager.fileViewModal.version')}:</strong> {fileDetail.versions.length}
              </Text>
            </Space>
          </div>
          {activeView === 'editor' ? (
            isMarkdownFile(filename || '') ? (
              <MarkdownPreview
                filename={filename || ''}
                content={content}
                onChange={handleContentChange}
                onSave={handleSave}
                isDirty={isDirty}
              />
            ) : (
              <div style={{ height: '60vh' }}>
                <FileEditor
                  filename={filename || ''}
                  content={content}
                  onChange={handleContentChange}
                  onSave={handleSave}
                  isDirty={isDirty}
                  loading={loading}
                />
              </div>
            )
          ) : (
            <div style={{ height: '60vh' }}>
              <FileVersionHistory
                filename={filename || ''}
                resourceId={resourceId}
                versions={fileDetail.versions}
                currentContent={content}
                getFileVersion={service.getFileVersion}
              />
            </div>
          )}
        </>
      ) : null}
    </Modal>
  );
};

export default FileViewModal;
