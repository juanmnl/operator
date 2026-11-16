import json,os,sys
d=json.load(open(sys.argv[1]))
for r in d['retainers'][:int(sys.argv[2]) if len(sys.argv)>2 else 5]:
    print('==',r['key'],r['countA'],'->',r['countB'],'dSelf',r['dSelf'])
    for s in r['signatures'][:2]: print('   dCount',s['dCount'],'dSelf',s['dSelf'],'|',s['sig'][:230])
