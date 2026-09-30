<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router';
</script>

<template>
  <header>
    <h1>NMOS Federation</h1>
    <nav>
      <RouterLink to="/channels">Channels</RouterLink>
      <RouterLink to="/devices">Devices</RouterLink>
      <RouterLink to="/settings">Einstellungen</RouterLink>
    </nav>
  </header>
  <main><RouterView /></main>
</template>

<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; }
header { display: flex; gap: 2rem; align-items: baseline; padding: 1rem 1.5rem; border-bottom: 1px solid #8884; }
h1 { font-size: 1.1rem; margin: 0; }
nav { display: flex; gap: 1rem; }
nav a { text-decoration: none; opacity: 0.7; }
nav a.router-link-active { opacity: 1; font-weight: 600; }
main { padding: 1.5rem; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.4rem 0.75rem; border-bottom: 1px solid #8883; font-variant-numeric: tabular-nums; }
</style>
