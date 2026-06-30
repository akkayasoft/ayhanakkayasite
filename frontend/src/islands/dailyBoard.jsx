import { createRoot } from 'react-dom/client';
import { DailyBoard } from '../components/DailyBoard.jsx';

// Island giris noktasi: EJS sayfasindaki mount node'u bulup React'i baslatir.
const mount = document.getElementById('island-daily-board');
if (mount) {
  createRoot(mount).render(<DailyBoard endpoint={mount.dataset.endpoint || '/api/admin/daily-board'} />);
}
