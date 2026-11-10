'use client';
import { useEffect, useState } from 'react';
import { Upload, FileText, Download, Eye, X, Paperclip } from 'lucide-react';
import { fileRepository, type Attachment } from './repository';
import { type ArchiveRecord } from './model';

export default function Attachments({record,disabled=false,canUpload=false,canDownload=false}:{record:ArchiveRecord;disabled?:boolean;canUpload?:boolean;canDownload?:boolean}){
  const [files,setFiles]=useState<Attachment[]>([]),[loading,setLoading]=useState(true),[uploading,setUploading]=useState(false);
  const [selected,setSelected]=useState<Attachment|null>(null),[message,setMessage]=useState(''),[error,setError]=useState('');
  useEffect(()=>{let active=true;if(!record.recordVersion){setLoading(false);return;}fileRepository.attachments(record.id).then(value=>{if(active)setFiles(value);}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[record.id,record.recordVersion]);
  async function upload(chosen:File[]){
    if(!chosen.length)return;setUploading(true);setError('');setMessage('');let added=0,duplicate=0;const failures:string[]=[];
    for(const file of chosen){try{if(file.size>20*1024*1024)throw new Error('超过20MB');const result=await fileRepository.uploadAttachment(record.id,file);result.duplicate?duplicate++:added++;}catch(e){failures.push(`${file.name}：${e instanceof Error?e.message:'上传失败'}`);}}
    try{setFiles(await fileRepository.attachments(record.id));}catch(e){failures.push((e as Error).message);}
    setMessage(`新增${added}个文件，重复跳过${duplicate}个。`);if(failures.length)setError(failures.join('；'));setUploading(false);
  }
  return <section className="attachments-section" aria-label="扫描附件管理"><div className="toolbar"><div className="section-title"><Paperclip size={17}/><h3>扫描附件</h3><span className="muted">{files.length} 个文件</span></div>{canUpload&&record.recordVersion>0&&record.status!=='void'&&<label className={`button compact upload-control ${disabled||uploading?'disabled':''}`}><Upload size={14}/>{uploading?'正在上传…':'上传附件'}<input aria-label="上传扫描附件" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" multiple disabled={disabled||uploading} onChange={e=>{const chosen=Array.from(e.target.files||[]);e.target.value='';void upload(chosen);}}/></label>}</div>
    <p className="attachment-hint">支持 PDF、PNG、JPG、WebP，单个文件最大20MB。文件数与扫描件份数分别记录。</p>
    {!record.recordVersion?<div className="attachment-empty">先保存草稿，再在档案详情或编辑页面上传附件。</div>:loading?<p role="status">正在读取附件…</p>:!files.length?<div className="attachment-empty"><FileText size={22}/><span>暂无扫描附件</span></div>:<ul className="attachment-list">{files.map(file=><li key={file.id}><FileText size={18}/><div className="attachment-name"><strong>{file.name}</strong><small>{formatSize(file.size)} · {new Date(file.createdAt).toLocaleDateString('zh-CN')}</small></div>{canDownload?<div className="actions"><button type="button" className="text-button" onClick={()=>setSelected(file)}><Eye size={14}/>预览</button><a className="text-button" href={fileRepository.attachmentUrl(file.id,true)}><Download size={14}/>下载</a></div>:<small>原文件未授权</small>}</li>)}</ul>}
    {uploading&&<p role="status" className="attachment-hint">请等待所选文件上传完成。</p>}{message&&<p role="status" className="attachment-message">{message}</p>}{error&&<div className="notice danger" role="alert">{error}</div>}
    {selected&&<div className="attachment-preview"><div className="toolbar"><strong>{selected.name}</strong><button type="button" className="text-button" onClick={()=>setSelected(null)}><X size={14}/>关闭预览</button></div>{selected.mime==='application/pdf'?<iframe title={`PDF预览：${selected.name}`} src={fileRepository.attachmentUrl(selected.id)+'#view=FitH'}/>:<img src={fileRepository.attachmentUrl(selected.id)} alt={selected.name}/>}<a className="text-button" href={fileRepository.attachmentUrl(selected.id,true)}>无法预览时下载原文件</a></div>}
  </section>;
}
function formatSize(value:number){return value>=1024*1024?`${(value/1024/1024).toFixed(1)} MB`:`${Math.max(1,Math.round(value/1024))} KB`;}
