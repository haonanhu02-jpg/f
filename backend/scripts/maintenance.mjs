import { parseArgs } from 'node:util';
import { createBackup,verifyBackup,restoreBackup,inspectDatabase } from '../src/operations.mjs';

try{
  const {values,positionals}=parseArgs({allowPositionals:true,options:{db:{type:'string'},out:{type:'string'},backup:{type:'string'},target:{type:'string'}}});
  let result;
  if(positionals[0]==='backup')result=await createBackup(values.db||process.env.ARCHIVE_DB_PATH,values.out||process.env.ARCHIVE_BACKUP_DIR);
  else if(positionals[0]==='verify'&&values.backup)result=await verifyBackup(values.backup);
  else if(positionals[0]==='restore'&&values.backup)result=await restoreBackup(values.backup,values.target);
  else if(positionals[0]==='check'&&(values.db||process.env.ARCHIVE_DB_PATH))result=inspectDatabase(values.db||process.env.ARCHIVE_DB_PATH);
  else throw new Error('Usage: maintenance.mjs backup --db FILE --out DIR | verify --backup DIR | restore --backup DIR --target NEW_FILE | check --db FILE');
  console.log(JSON.stringify(result,null,2));
}catch(error){console.error(error.message);process.exitCode=1;}
