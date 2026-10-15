import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import App from './App.vue';
import Channels from './views/Channels.vue';
import Bridges from './views/Bridges.vue';
import Settings from './views/Settings.vue';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/channels' },
    { path: '/channels', component: Channels, name: 'Channels' },
    { path: '/bridges', component: Bridges, name: 'Bridges' },
    // Copying moved onto the Bridges page; old links and bookmarks land there.
    { path: '/copy', redirect: '/bridges' },
    { path: '/settings', component: Settings, name: 'Settings' },
  ],
});

createApp(App).use(router).mount('#app');
