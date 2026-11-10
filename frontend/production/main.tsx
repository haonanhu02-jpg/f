import { createRoot } from 'react-dom/client';
import AuthGate from '../features/archive/AuthGate';
import '../app/globals.css';

createRoot(document.getElementById('root')!).render(<AuthGate/>);
