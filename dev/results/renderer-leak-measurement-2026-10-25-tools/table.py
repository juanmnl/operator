import json,os,collections
S=os.environ['S']
rows=[json.loads(l) for l in open(S+'/samples/samples.jsonl')]
print('min  heapUsedMB heapTotalMB  dom listeners lanes | RSS MB: main renderer gpu utility lane-child(total,n) | renderer footprint')
for r in rows:
    h=r.get('heap') or {}
    agg=collections.defaultdict(int); n=collections.Counter()
    for p in r['procs']:
        l=p['label'].split(':')[0]; agg[l]+=p['rssKB']; n[l]+=1
    fp=(r.get('renderer_footprint') or '')
    import re
    m=re.search(r'phys_footprint: (\S+ \S+)',fp)
    print(f"{r['elapsedMin']:>4} {h.get('usedSize',0)/1048576:9.1f} {h.get('totalSize',0)/1048576:11.1f} {h.get('dom','-'):>5} {h.get('jsEventListeners','-'):>6} {h.get('lanes','-'):>3} | {agg['main']/1024:6.0f} {agg['renderer']/1024:8.0f} {agg['gpu']/1024:5.0f} {agg['utility']/1024:6.0f} {agg['lane-child']/1024:7.0f} (n={n['lane-child']}) | {m.group(1) if m else fp[:30]}")
