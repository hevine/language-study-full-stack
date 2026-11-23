import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AuthProvider } from './auth/AuthProvider';
import '@waiyubaodian/explain-video/styles.css';
// UI 组件库：主题令牌 + 组件样式（表单控件 / 下拉 / 流光玻璃框）
import '@waiyubaodian/ui-kit/styles.css';
import './styles.css';
import './components/uikit.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root 不存在');

createRoot(container).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>,
);
