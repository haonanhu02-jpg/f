'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { X, Inbox } from 'lucide-react';

export function Field({ label, children, hint, required, wide }: { label: string; children: ReactNode; hint?: string; required?: boolean; wide?: boolean }) {
  return <label className={`field ${wide ? 'wide' : ''}`}><span>{label}{required && <span className="required"> *</span>}</span>{children}{hint && <small>{hint}</small>}</label>;
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'blue' | 'amber' | 'green' }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function Empty({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <div className="empty"><span className="empty-icon"><Inbox size={30}/></span><h3>{title}</h3><p>{description}</p><div className="actions">{children}</div></div>;
}
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} aria-labelledby="modal-title" onCancel={e => { e.preventDefault(); onClose(); }}><div className="modal-head"><h2 id="modal-title">{title}</h2><button type="button" className="icon-button" aria-label="关闭对话框" onClick={onClose}><X size={20}/></button></div>{children}</dialog>;
}
