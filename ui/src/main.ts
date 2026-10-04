import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import App from './App.vue';
import Channels from './views/Channels.vue';
import Devices from './views/Devices.vue';
import Copy from './views/Copy.vue';
import Settings from './views/Settings.vue';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/channels' },
    { path: '/channels', component: Channels, name: 'Channels' },
    { path: '/devices', component: Devices, name: 'Devices' },
    { path: '/copy', component: Copy, name: 'Copy' },
    { path: '/settings', component: Settings, name: 'Settings' },
  ],
});

createApp(App).use(router).mount('#app');
