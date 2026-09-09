import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircleOutlined, InfoCircleOutlined, ExclamationCircleOutlined, CloseCircleOutlined, CloseOutlined } from '@ant-design/icons';
import './GlobalNotification.css';

export type NotificationType = 'success' | 'info' | 'warning' | 'error';
export interface NotificationItem {
  id: string;
  type: NotificationType;
  title: string;
  message?: string;
  duration?: number;
  onClose?: () => void;
}
interface GlobalNotificationProps {
  notifications: NotificationItem[];
  onRemove: (id: string) => void;
}
const icons = {
  success: <CheckCircleOutlined style={{ color: '#52c41a' }} />,
  info: <InfoCircleOutlined style={{ color: '#1890ff' }} />,
  warning: <ExclamationCircleOutlined style={{ color: '#faad14' }} />,
  error: <CloseCircleOutlined style={{ color: '#ff4d4f' }} />,
};

const Notification: React.FC<{ item: NotificationItem; onRemove: GlobalNotificationProps['onRemove'] }> = ({ item, onRemove }) => {
  const [phase, setPhase] = useState<'entering' | 'visible' | 'exiting'>('entering');
  const closing = useRef(false);
  const removed = useRef(false);
  const latest = useRef({ item, onRemove });
  latest.current = { item, onRemove };
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    setPhase('exiting');
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setPhase(current => current === 'entering' ? 'visible' : current), 0);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!item.duration || item.duration <= 0 || phase === 'exiting') return;
    const timer = setTimeout(close, item.duration);
    return () => clearTimeout(timer);
  }, [item.duration, phase, close]);
  useEffect(() => {
    if (phase !== 'exiting') return;
    const timer = setTimeout(() => {
      if (removed.current) return;
      removed.current = true;
      latest.current.onRemove(latest.current.item.id);
      latest.current.item.onClose?.();
    }, 300);
    return () => clearTimeout(timer);
  }, [phase]);

  return <div className={`global-notification notification-${item.type} ${phase === 'visible' ? 'visible' : 'hidden'}`}>
    <div className="notification-content">
      <div className="notification-icon">{icons[item.type]}</div>
      <div className="notification-text">
        <div className="notification-title">{item.title}</div>
        {item.message && <div className="notification-message">{item.message}</div>}
      </div>
      <button type="button" aria-label="Close" className="notification-close" onClick={close} style={{ cursor: 'pointer', border: 0, background: 'none', color: 'var(--text-secondary)' }}>
        <CloseOutlined />
      </button>
    </div>
  </div>;
};

const GlobalNotification: React.FC<GlobalNotificationProps> = ({ notifications, onRemove }) => notifications.length ? (
  <div className="global-notifications-container">
    {notifications.map(item => <Notification key={item.id} item={item} onRemove={onRemove} />)}
  </div>
) : null;

export default GlobalNotification;
