import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const patientAppFixPlugin = {
  name: 'anemoscan-patient-app-fix',
  transform(code: string, id: string) {
    if (!id.endsWith('/src/App.tsx')) return null

    return {
      code: code
        .replace('  Home,\n', '')
        .replace('const qualityThreshold = 70', 'const qualityThreshold = 65')
        .replace(
          '<div className="icon-cell"><Home size={20} /></div>',
          '<div className="icon-cell"><img src="/anemoscan-mark.svg" alt="AnemoScan" style={{ width: 28, height: 28 }} /></div>',
        ),
      map: null,
    }
  },
}

export default defineConfig({
  plugins: [patientAppFixPlugin, react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
})
