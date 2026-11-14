export type GoogleOperation = 'oauth.token'|'oauth.tokenInfo'|'picker.sessions.create'|'picker.sessions.get'|'picker.sessions.delete'|'picker.mediaItems.list'|'media.download';
export interface GoogleDiagnostic {
  operation:GoogleOperation;
  httpStatus:number;
  googleCode?:number;
  googleStatus?:string;
  reason?:string;
  domain?:string;
  service?:string;
  consumerProject?:string;
  message:string;
}

const record=(value:unknown):Record<string,unknown>=>value!==null && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
const identifier=(value:unknown):string|undefined=>typeof value==='string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,100}$/.test(value) ? value : undefined;

/** Only allowlisted fields leave this boundary. Headers, request URLs and arbitrary metadata never do. */
export function sanitizeGoogleMessage(value:unknown,secrets:readonly string[]=[]):string {
  if(typeof value!=='string') return 'Google returned an error without a readable message.';
  let text=value;
  for(const secret of [...secrets].filter(secret=>secret.length>=3).sort((a,b)=>b.length-a.length)) text=text.split(secret).join('[redacted]');
  text=text
    .replace(/Bearer\s+[^\s,;"']+/gi,'Bearer [redacted]')
    .replace(/\b(?:access_token|refresh_token|client_secret|authorization_code|code_verifier|code_challenge|code)\s*[:=]\s*[^\s,;"']+/gi,'[redacted credential]')
    .replace(/(?:https?:\/\/|www\.)[^\s<>"']+/gi,'[redacted URL]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g,'[redacted email]')
    .replace(/\b(?:ya29\.[\w.-]+|GOCSPX-[\w-]+|1\/\/[\w.-]+|4\/[\w.-]+)/g,'[redacted credential]')
    .replace(/\b[^\s\/\\"']+\.(?:jpe?g|png|webp|gif|heic|mp4|mov)\b/gi,'[redacted media]')
    .replace(/(["'`])[^"'`]*\1/g,'[redacted detail]')
    .replace(/\b[A-Za-z0-9_-]{32,}(?:\.[A-Za-z0-9_-]+)*\b/g,'[redacted identifier]')
    .replace(/[\x00-\x1f\x7f]/g,' ')
    .replace(/\s+/g,' ').trim();
  return text.slice(0,500) || 'Google returned an error without a readable message.';
}

export function googleDiagnostic(operation:GoogleOperation,httpStatus:number,payload:unknown,secrets:readonly string[]=[]):GoogleDiagnostic {
  const safeIdentifier=(value:unknown):string|undefined=>{
    const candidate=identifier(value);
    return candidate && !/(?:ya29\.|GOCSPX-|Bearer[._-])/i.test(candidate) && !secrets.some(secret=>secret.length>=3 && candidate.includes(secret)) ? candidate : undefined;
  };
  const safeStatus=(value:unknown)=>typeof value==='string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? safeIdentifier(value) : undefined;
  const root=record(payload);
  const error=record(root.error);
  const details=Array.isArray(error.details)?error.details.map(record):[];
  const errorInfo=details.find(detail=>detail['@type']==='type.googleapis.com/google.rpc.ErrorInfo') ?? {};
  const legacy=Array.isArray(error.errors)?error.errors.map(record):[];
  const metadata=record(errorInfo.metadata);
  const reason=safeIdentifier(errorInfo.reason) ?? legacy.map(item=>safeIdentifier(item.reason)).find(Boolean) ?? safeIdentifier(typeof root.error==='string'?root.error:undefined);
  const domain=safeIdentifier(errorInfo.domain) ?? legacy.map(item=>safeIdentifier(item.domain)).find(Boolean);
  const consumer=typeof metadata.consumer==='string' && /^projects\/\d{1,24}$/.test(metadata.consumer) ? metadata.consumer : undefined;
  const message=error.message ?? root.error_description ?? (typeof root.error==='string'?root.error:undefined);
  return {
    operation,httpStatus,
    ...(typeof error.code==='number' && Number.isInteger(error.code)?{googleCode:error.code}:{}),
    ...(safeStatus(error.status)?{googleStatus:safeStatus(error.status)}:{}),
    ...(reason?{reason}:{}),...(domain?{domain}:{}),
    ...(typeof metadata.service==='string' && /^[a-z0-9.-]+\.googleapis\.com$/.test(metadata.service)?{service:metadata.service}:{}),
    ...(consumer?{consumerProject:consumer}:{}),
    message:sanitizeGoogleMessage(message,secrets),
  };
}
