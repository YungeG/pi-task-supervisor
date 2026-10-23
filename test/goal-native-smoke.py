#!/usr/bin/env python3
"""Offline actual CLI/PTY lifecycle checks; synthetic keys are not human identity proof."""
import argparse, errno, fcntl, hashlib, json, os, pathlib, pty, re, select, shutil, signal, struct, tempfile, termios, time, uuid

parser = argparse.ArgumentParser()
parser.add_argument('scenario', choices=['sequential', 'permissions', 'information', 'sdk-denial'])
parser.add_argument('--source', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent.parent)
parser.add_argument('--cli', type=pathlib.Path)
parser.add_argument('--out', type=pathlib.Path)
parser.add_argument('--decision-layouts', action='store_true', help='exercise optional Markdown reading and wide split without submitting')
args = parser.parse_args()
source = args.source.resolve()
cli = (args.cli or source/'node_modules/@earendil-works/pi-coding-agent/dist/cli.js').resolve()
node = shutil.which('node')
assert node and cli.is_file(), 'matching installed CLI is required; no dependency installation is performed'
out = args.out.resolve() if args.out else pathlib.Path(tempfile.mkdtemp(prefix='goal-native-'))
out.mkdir(parents=True, exist_ok=True)
sandbox = pathlib.Path(tempfile.mkdtemp(prefix='owned-', dir=out))
settings = pathlib.Path.home()/'.pi/agent/settings.json'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else 'absent'
before = sha(settings)
session_id = str(uuid.uuid4())
now = '2026-10-20T00:00:00.000Z'
path = sandbox/'session.jsonl'
task = {'id':'old-task', 'title':'Old unfinished synthetic task', 'prompt':'Owned synthetic data only', 'profile':'worker', 'phase':1, 'status':'implementing', 'dependencies':[], 'createdAt':now, 'updatedAt':now}
board = {'version':2, 'generation':47, 'workflowStatus':'paused', 'pauseReason':'Synthetic old stop', 'stagnantSettles':0, 'finalAcceptanceTaskId':'old-task', 'tasks':[task], 'phases':[{'phase':1,'status':'active'}]}
owner = {'version':3, 'sessionId':session_id, 'goal':'Old synthetic native history', 'model':{'provider':'goal-native-fixture','id':'test'}, 'status':'stopped', 'reviews':40, 'continuations':20, 'stagnant':3, 'epoch':0, 'pending':False, 'reason':'Stopped synthetic history', 'holdCause':'user_pause', 'receipts':[], 'bindings':[], 'tokens':123, 'cost':0.5, 'receiptLedger':{'goalId':'old-native-goal','sequence':0,'head':None,'receiptCount':0,'epoch':0,'pending':[]}}
records = [{'type':'session','version':3,'id':session_id,'timestamp':now,'cwd':str(sandbox)}]
parent = None
for i, (kind, value) in enumerate([('continuous-tasks:activation',{'version':1,'enabled':True}),('continuous-tasks:snapshot',board),('continuous-tasks:supervisor',owner)]):
    entry = {'type':'custom','id':f'old-{i}','parentId':parent,'timestamp':now,'customType':kind,'data':value}
    records.append(entry); parent = entry['id']
seed = ''.join(json.dumps(row,separators=(',',':'))+'\n' for row in records).encode()
path.write_bytes(seed)
env = {k:v for k,v in os.environ.items() if not k.startswith(('PI_SESSION_', 'PI_SUBAGENT', 'PI_INTERCOM', 'PI_SUPERVISOR'))}
env.update(PI_CODING_AGENT_DIR=str(sandbox/'agent'), PI_OFFLINE='1', PI_SKIP_VERSION_CHECK='1', PI_TELEMETRY='0', TERM='xterm-256color', GOAL_NATIVE_SCENARIO=args.scenario, GOAL_NATIVE_OUT=str(sandbox))
argv = [node, str(cli), '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '-e', str(source/'test/goal-native-fixture.ts'), '--model', 'goal-native-fixture/test', '--session', str(path), '--session-dir', str(sandbox/'sessions')]
if args.scenario == 'sdk-denial':
    argv = [node, str(source/'test/goal-sdk-negative.mjs')]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(sandbox); os.execve(node, argv, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 120, 0, 0))
ansi = re.compile(rb'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-Z\\-_])')
data = bytearray(); transcript = sandbox/'terminal.log'; log = transcript.open('wb'); stage = 'startup'
overall_deadline = time.monotonic()+150
layout_checks = 0
def text():
    return ansi.sub(b'', bytes(data)).decode('utf8', 'replace')
def receive(pattern, timeout=40):
    deadline = min(overall_deadline, time.monotonic()+timeout)
    while time.monotonic() < deadline:
        match = re.search(pattern, text())
        if match: return match
        ready, _, _ = select.select([fd], [], [], max(0, deadline-time.monotonic()))
        if not ready: break
        try: chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno == errno.EIO: break
            raise
        if not chunk: break
        data.extend(chunk); log.write(chunk); log.flush()
    raise RuntimeError(stage+': expected '+pattern+'; tail='+text()[-4000:])
def send(value):
    data.clear(); os.write(fd, value.encode())
def command(value):
    send(value+'\r')
def card_layouts():
    global layout_checks
    send('\x1bOS'); receive('格式化浏览')
    send('\x1b'); receive('A 会话卡')
    send('\x1bOR'); receive('C 双栏')
    send('\x1bOS'); receive('格式化浏览')
    send('\x1b'); receive('C 双栏')
    send('\x1bOR'); receive('A 会话卡')
    layout_checks += 1
def answer(kind):
    global stage
    stage = 'native draft and scope review '+kind
    receive('需要你回应|只读核对|格式化浏览')
    if '需要你回应' in text():
        if args.decision_layouts: card_layouts()
        send('\x1b[B'); receive('→.*(?:允许上述范围|开始执行|选项 1)')
        send('\r'); receive('只读核对')
        for _ in range(128):
            send('\r')
            match=receive(r'(需要你回应)|(第\s*\d+/\d+\s*页)')
            if match.group(1): break
        else: raise AssertionError('native source review did not return to draft')
        stage = 'explicit draft submit, then native final '+kind
        send('\r'); receive('全文已核对')
        send('\x1b[B\r')
        return
    if '格式化浏览' in text():
        send('r'); receive('只读核对')
    receive(r'下一页:|继续作答:')
    for _ in range(128):
        send('\r')
        match = receive(r'(全文已核对)|(第\s*\d+/\d+\s*页)')
        if match.group(1): break
    else: raise AssertionError('native review exceeded bounded page count')
    stage = 'native final answer '+kind
    send('\x1b[B\r')
def probe(label):
    global stage
    stage = 'readonly native probe '+label
    command('/goal-native-probe '+label); receive('GOAL_NATIVE_SAVED_'+re.escape(label))
    value = json.loads((sandbox/(label+'.json')).read_text())
    assert value['stdinTty'] and value['stdoutTty'] and value['mode']=='tui' and not value['nativeSourceMocked']
    assert pathlib.Path(value['sessionFile']).resolve() == path
    assert pathlib.Path(value['argv1']).resolve() == cli
    return value
def goal_records(value):
    return [row for row in value['entries'] if row.get('customType')=='continuous-tasks:supervisor' and row['data'].get('version')==5]
def selected(value):
    return [row for row in goal_records(value) if row['data']['kind']=='transition-committed'][-1]
def current_preflight(value):
    commit = selected(value); gid = commit['data']['seed']['goalRunId']
    rows = [row for row in value['entries'] if row.get('customType')=='continuous-tasks:preflight' and row['data'].get('goalRunId')==gid]
    return rows[-1]['data']['snapshot'] if rows else commit['data']['seed']['preflight']
def verify_native_commits(value):
    rows = value['entries']; indices = {row['id']:i for i,row in enumerate(rows)}
    for commit in [row for row in goal_records(value) if row['data']['kind']=='transition-committed']:
        c = commit['data']; a = next(row for row in rows if row['id']==c['controlEntryId']); b = next(row for row in rows if row['id']==c['witnessEntryId'])
        assert indices[a['id']] < indices[b['id']] < indices[commit['id']]
        assert b['customType']=='continuous-tasks:human-readback' and b['data']['controlEntryId']==a['id']
        assert b['data']['frame']['version']==2 and b['data']['frame']['owner']=='goal'
        assert c['seed']==a['data']['seed'] and c['from']==a['data']['from']
        assert c['seed']['board']['tasks']==[] and c['seed']['board']['workflowStatus']=='inactive'
        assert c['seed']['preflight']['revision']==0 and c['seed']['preflight']['phase']=='planning'
        assert 'approval' not in c['seed']['preflight'] and 'started' not in c['seed']['preflight']
if args.scenario == 'sdk-denial':
    reaped = False
    try:
        receive('GOAL_SDK_DENIAL_SAVED')
        value = json.loads((sandbox/'sdk-denial.json').read_text())
        assert value['result']=='PASS' and value['physicalJournalUnchanged'] and value['uiCalls']==0
        deadline = time.monotonic()+10
        while time.monotonic() < deadline:
            ended, status = os.waitpid(pid, os.WNOHANG)
            if ended:
                reaped = True; assert os.WIFEXITED(status) and os.WEXITSTATUS(status)==0; break
            time.sleep(0.02)
        else: raise AssertionError('ordinary SDK fixture did not settle')
        assert sha(settings)==before
        report = {**value, 'source':str(source), 'script':str(source/'test/goal-sdk-negative.mjs'), 'transcript':str(transcript), 'probe':str(sandbox/'sdk-denial.json')}
        (sandbox/'verified.json').write_text(json.dumps(report,indent=2)+'\n'); print(json.dumps(report),flush=True)
    finally:
        log.close()
        if not reaped:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
            try: os.waitpid(pid, 0)
            except ChildProcessError: pass
        os.close(fd)
    raise SystemExit(0)
try:
    receive('GOAL_NATIVE_READY'); initial = probe('initial'); assert initial['modelCalls']==0
    if args.scenario == 'information':
        stage = 'native same-screen information input'
        command('/goal-native-information'); receive('需要你回应')
        send('42'); receive('42')
        send('\x1bOS'); receive('格式化浏览')
        send('\x1b'); receive('A 会话卡')
        send('\x1bOR'); receive('C 双栏')
        send('\t'); receive('焦点：完整原文')
        send('\r'); receive('完整原文已核对')
        send('\r'); receive('补充信息（全文已核对）')
        send('\x1b[B\r'); receive('GOAL_NATIVE_INFORMATION_SAVED')
        final = probe('information-final')
        controls=[row for row in final['entries'] if row.get('customType')=='continuous-tasks:event' and row['data'].get('type')=='resolve_decision']
        assert len(controls)==1 and controls[0]['data']['answer']=='42' and controls[0]['data']['outcome']=='answer'
        witnesses=[row for row in final['entries'] if row.get('customType')=='continuous-tasks:human-readback']
        assert len(witnesses)==1 and witnesses[0]['data']['controlEntryId']==controls[0]['id']
        assert final['modelCalls']==0 and sha(settings)==before and path.read_bytes().startswith(seed)
        report={'result':'PASS','scenario':'information','source':str(source),'actualCli':str(cli),'nativeSourceMocked':False,'syntheticKeystrokes':True,'businessExecutionCertified':False,'typedInformation':'42','sameScreenInput':True,'readonlyReturnPreservedDraft':True,'wideSourceReview':True,'nativeFinalConfirmed':True,'settingsUnchanged':True,'originalHistoryBytesUnchanged':True,'probe':str(sandbox/'information-final.json'),'sessionFile':str(path),'transcript':str(transcript)}
        (sandbox/'verified.json').write_text(json.dumps(report,indent=2)+'\n'); print(json.dumps(report),flush=True)
        raise SystemExit(0)
    stage = 'native archive-and-plan'
    command('/task-supervisor supervise Owned native next goal'); answer('archive')
    if args.scenario == 'sequential':
        stage = 'first readonly planning'; receive('GOAL_NATIVE_IDLE_1'); first = probe('first')
        gid = first['currentGoalRunId']; assert all(row['data'].get('supervisor') is None for row in goal_records(first) if row['data']['kind']=='goal-state')
        command('/task-supervisor preflight'); stage = 'same-goal explicit planning'; receive('GOAL_NATIVE_IDLE_2'); replanned = probe('replanned')
        assert replanned['currentGoalRunId']==gid
        assert any(row['data']['kind']=='goal-state' and row['data']['planning']['attemptNo']==1 for row in goal_records(replanned))
        command('/task-supervisor stop'); stopped = probe('stopped'); assert goal_records(stopped)[-1]['data']['disposition']=='closed-unstarted'
        command('/task-supervisor supervise Owned native following goal'); answer('following archive')
        stage = 'following readonly planning'; receive('GOAL_NATIVE_IDLE_3'); final = probe('final')
        assert final['currentGoalRunId']!=gid and len([row for row in goal_records(final) if row['data']['kind']=='transition-committed'])==2
        assert final['modelCalls']==3
        assert not any(row.get('customType')=='continuous-tasks:preflight-control' for row in final['entries'])
        messages = [row for row in final['entries'] if row.get('type')=='custom_message' and row.get('customType')=='continuous-tasks:preflight-planning']
        assert len(messages)==3
        for message in messages:
            index = next(i for i,row in enumerate(final['entries']) if row['id']==message['id'])
            assert any(row['data'].get('action')=='claim-planning-dispatch' and row['data']['planning']['attemptId'] in message['content'] for row in goal_records({'entries':final['entries'][:index]}))
    else:
        answer('required permission')
        stage = 'approved without execution'; receive('GOAL_NATIVE_IDLE_1'); approved = probe('approved')
        assert current_preflight(approved)['phase']=='approved'
        assert not any(row['data'].get('supervisor') is not None for row in goal_records(approved) if row['data']['kind']=='goal-state')
        command('/task-supervisor start'); answer('separate first-start')
        stage = 'owned no-effect Main settled'; receive('GOAL_NATIVE_IDLE_2'); final = probe('final')
        starts = [row for row in final['entries'] if row.get('customType')=='continuous-tasks:preflight-control' and row['data'].get('kind')=='start']; assert len(starts)==1
        states = [row['data']['supervisor'] for row in goal_records(final) if row['data']['kind']=='goal-state' and row['data'].get('supervisor') is not None]
        first = states[0]
        assert all(first[key]==0 for key in ['reviews','continuations','stagnant','tokens','cost','epoch'])
        assert first['bindings']==[] and first['receiptLedger']['receiptCount']==0 and first['receiptLedger']['pending']==[]
        assert first['receiptLedger']['goalId']==final['currentGoalRunId']
        assert current_preflight(final)['phase']=='started'
    verify_native_commits(final)
    raw = path.read_bytes(); assert raw.startswith(seed) and raw.endswith(b'\n')
    assert sha(settings)==before
    report = {'result':'PASS','scenario':args.scenario,'source':str(source),'actualCli':str(cli),'nativeSourceMocked':False,'syntheticKeystrokes':True,'businessExecutionCertified':False,'decisionLayoutChecks':layout_checks,'settingsUnchanged':True,'originalHistoryBytesUnchanged':True,'probe':str(sandbox/'final.json'),'sessionFile':str(path),'transcript':str(transcript)}
    (sandbox/'verified.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report), flush=True)
finally:
    log.close()
    try: os.kill(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    try: os.waitpid(pid, 0)
    except ChildProcessError: pass
    os.close(fd)
