#!/usr/bin/env python3
"""Provision a single-use owner setup link using server credentials from environment.
Writes to a local private file; NEVER prints the link or credentials or commits it.
"""
import argparse, hashlib, json, os, pathlib, secrets, urllib.request, urllib.parse

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--page-url',required=True,help='HTTPS admin_settings.html URL for this academy')
    parser.add_argument('--output',default='admin-setup-link.private.txt')
    args=parser.parse_args()
    page=urllib.parse.urlparse(args.page_url)
    if page.scheme!='https' or not page.netloc or page.query or page.fragment:
        raise SystemExit('Use the HTTPS page URL without a query or fragment.')
    base=os.environ.get('SB_URL','').rstrip('/')
    key=os.environ.get('SB_SERVICE_ROLE_KEY','')
    if not base.startswith('https://') or not key:
        raise SystemExit('SB_URL and SB_SERVICE_ROLE_KEY must be present in the secure environment.')
    token=secrets.token_hex(32)
    payload=json.dumps({'p_action':'provision','p_data':{'setup_hash':hashlib.sha256(token.encode()).hexdigest()}}).encode()
    path=pathlib.Path(args.output)
    # Refuse to overwrite an existing link or follow a symlink.
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:
        request=urllib.request.Request(base+'/rest/v1/rpc/hada_security_command',data=payload,headers={'Content-Type':'application/json','apikey':key,'Authorization':'Bearer '+key})
        with urllib.request.urlopen(request,timeout=20) as response: result=json.load(response)
        if result.get('error'):raise RuntimeError(result['error'])
        with os.fdopen(fd,'w') as f:
            fd=-1
            f.write(args.page_url+'#setup='+token+'\n')
            f.write('Expires: '+result['expires_at']+'\n')
    except Exception:
        if fd!=-1:os.close(fd)
        path.unlink(missing_ok=True)
        raise SystemExit('Provisioning did not finish. Check the server configuration; no credentials were printed.')
    print('Private setup link written to local file. Expires in 48 hours; do not upload to GitHub or Notion.')

if __name__=='__main__':main()
