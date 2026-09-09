import { getErrorMessage } from '../../utils/errors';
// src/components/common/CodeBlockPreview.tsx
import React from 'react';
import { Button, Tooltip, message } from 'antd';
import { previewService } from '../../services/previewService';
import { EyeOutlined } from '@ant-design/icons';

interface CodeBlockPreviewProps {
  language: string;
  content: string;
  className?: string;
  isStreaming?: boolean; // 新增：是否正在流式传输
  conversationId?: string; // 新增：对话ID，用于持久化状态
}

const CodeBlockPreview: React.FC<CodeBlockPreviewProps> = ({ language, content, className, isStreaming = false }) => {
  const isReady = !isStreaming && !!content.trim() && (
    (language === 'html' && content.includes('<')) || language === 'mermaid' ||
    (language === 'svg' && content.includes('<svg'))
  );

  const handlePreview = async (e: React.MouseEvent) => {
    // 阻止事件冒泡，避免触发父组件的展开/收起
    e.stopPropagation();

    // 调用后端生成短链ID，打开短链预览页面
    try {
      const resp = await previewService.createShare({
        lang: language || 'text',
        content,
        title: `${(language || 'text').toUpperCase()} 预览`
      });

      const origin = window.location.origin;
      const shareUrl = `${origin}/preview?id=${encodeURIComponent(resp.id)}`;
      const win = window.open(shareUrl, '_blank');
      if (!win) {
        message.error('无法打开预览窗口，请检查浏览器设置');
      } else {
        message.success('短链已生成，可分享该链接');
      }
    } catch (e) {
      message.error('生成短链失败：' + getErrorMessage(e));
    }
  };

  // 检查是否支持预览
  const supportsPreview = isReady && (language === 'html' || language === 'mermaid' || language === 'svg');

  if (!supportsPreview) {
    return null;
  }

  return (
    <Tooltip title="在新窗口中预览（可分享链接）">
      <Button
        type="text"
        size="small"
        icon={<EyeOutlined />}
        onClick={handlePreview}
        className={['preview-button', className].filter(Boolean).join(' ')}
      />
    </Tooltip>
  );
};

export default CodeBlockPreview;