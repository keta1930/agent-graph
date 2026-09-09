import { Spin } from 'antd';
import { useTranslation } from '../../i18n';

export default function PageLoading() {
  const { t } = useTranslation();
  return <div role="status" style={{ minHeight: '40vh', display: 'grid', placeContent: 'center', gap: 16, textAlign: 'center' }}>
    <Spin size="large" />
    <span>{t('common.loading')}</span>
  </div>;
}
