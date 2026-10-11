#!/usr/bin/env python3
"""Reset one academy's admin password back to the initial password (0000).

Deploy-manager tool. Reads SB_URL and SB_SERVICE_ROLE_KEY for THAT academy's Supabase project from
the environment (never pass them as arguments, never commit them). All admin/kiosk sessions are
logged out. The owner then logs in to admin_settings.html with 0000 and must set a new password
before any kiosk or document page accepts it. Notion webhook keys are not changed.
"""
import argparse, json, os, urllib.request

def main():
    parser=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--confirm',action='store_true',help='required: confirms this academy should be reset')
    args=parser.parse_args()
    if not args.confirm:
        raise SystemExit('Add --confirm to reset this academy to the initial password.')
    base=os.environ.get('SB_URL','').rstrip('/')
    key=os.environ.get('SB_SERVICE_ROLE_KEY','')
    if not base.startswith('https://') or not key:
        raise SystemExit('SB_URL and SB_SERVICE_ROLE_KEY must be present in the secure environment.')
    payload=json.dumps({'p_action':'reset','p_data':{}}).encode()
    request=urllib.request.Request(base+'/rest/v1/rpc/hada_security_command',data=payload,headers={'Content-Type':'application/json','apikey':key,'Authorization':'Bearer '+key})
    try:
        with urllib.request.urlopen(request,timeout=20) as response: result=json.load(response)
    except Exception:
        raise SystemExit('Reset did not finish. Check SB_URL and the network; no credentials were printed.')
    if result.get('error'):
        raise SystemExit('Reset refused: '+str(result['error']))
    print('Reset requested. The owner logs in to the admin settings page with 0000 and sets a new password.')

if __name__=='__main__':main()
