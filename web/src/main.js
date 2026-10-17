import { createApp } from 'vue';
import './style.css';
import App from './App.vue';
import { initTheme } from './composables/useTheme.js';

// Resolve + apply the theme before mount (index.html already did a pre-paint pass;
// this attaches the live system-preference listener and keeps <html> in sync with ui.theme).
initTheme();

createApp(App).mount('#app');
