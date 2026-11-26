// The app is served under /app/ (vite.config's base), which Vitest does not
// apply; links and addresses in tests read as they do in the app.
import.meta.env.BASE_URL = '/app/'
