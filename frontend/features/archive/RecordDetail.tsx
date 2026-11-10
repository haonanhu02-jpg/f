'use client';
import { type ArchiveRecord, type Workspace, groupLabels, resolvePath, validityLabels, retentionLabels, statusLabels } from './model';
import { Badge, Modal } from './ui';
import Attachments from './Attachments';

export default function RecordDetail({ record, state, onClose, onEdit, onRegister, onVoid, saving }: { record: ArchiveRecord; state: Workspace; onClose: () => void; onEdit: () => void; onRegister: () => void; onVoid: () => void; saving: boolean }) {
  const company = state.companies.find(c => c.id === record.companyId);
  const details = [
    ['所属公司', company?.name], ['档案大类', groupLabels[record.group]],
    ['档案分类', resolvePath(state.categories, record.categoryIds).map(n => n.name).join(' / ') || '不适用'], ['档号', record.archiveNumber || '待正式入账后分配'],
    ['证书编号', record.certificateNumber], ['发证单位', record.issuingAuthority], ['发证日期', record.issuedOn],
    ['有效期限', record.validityMode === 'fixed' ? `${record.validFrom || '未填写'} 至 ${record.validUntil}` : validityLabels[record.validityMode]],
    ['原件数量（份）', record.originalCount === null ? '待核实' : String(record.originalCount)], ['复印件数量（份）', record.copyCount === null ? '待核实' : String(record.copyCount)],
    ['扫描件数量（份）', record.scanCount === null ? '待核实' : String(record.scanCount)], ['移交人', record.transferPerson],
    ['移交部门', state.departments.find(d => d.id === record.departmentId)?.name], ['秘密等级', state.confidentialityLevels.find(l=>l.id===record.confidentialityLevel)?.name || '待核定（未定密）'],
    ['保存开始日期', record.retentionFrom], ['保存期限', record.retentionMode === 'fixed' ? `有期限，至 ${record.retentionUntil}` : retentionLabels[record.retentionMode]],
    ['存放位置', record.storageLocation], ['编号年份', record.numberingYear || '不适用'],
    ['登记时间', record.registeredAt ? new Date(record.registeredAt).toLocaleString('zh-CN') : '未登记'],
    ['作废原因', record.voidReason || '不适用'],
  ];
  return <Modal title="档案详情" onClose={onClose} wide><div className="modal-body"><div className="detail-title"><h3>{record.title}</h3><Badge tone={record.status === 'registered' ? 'green' : 'blue'}>{statusLabels[record.status]}</Badge></div><dl className="detail-grid">{details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || '未填写'}</dd></div>)}</dl>{record.registrationSnapshot && <div className="detail-notes"><h3>登记时的归档信息</h3><p>{record.registrationSnapshot.companyName} / {record.registrationSnapshot.categoryPath.map(c => c.name).join(' / ') || groupLabels[record.group]}</p></div>}<div className="detail-notes"><h3>备注</h3><p>{record.remarks || '未填写'}</p></div><Attachments record={record} disabled={saving} canUpload={state.capabilities.write} canDownload={state.capabilities.download}/></div><div className="modal-footer"><button className="button" onClick={onClose}>关闭</button>{state.capabilities.write && record.status !== 'void' && <button className="button" disabled={saving} onClick={onEdit}>编辑档案</button>}{state.capabilities.write && record.status === 'draft' && <button className="button primary" disabled={saving} onClick={onRegister}>正式入账</button>}{state.capabilities.write && record.status === 'registered' && <button className="button danger-button" disabled={saving} onClick={onVoid}>作废档案</button>}</div></Modal>;
}
