#!/usr/bin/env python3
"""Offline actual CLI/PTY lifecycle checks; synthetic keys are not human identity proof."""
import argparse, errno, fcntl, hashlib, json, os, pathlib, pty, re, select, shutil, signal, struct, subprocess, tempfile, termios, time, uuid

parser = argparse.ArgumentParser()
parser.add_argument('scenario', choices=['sequential', 'permissions', 'information', 'sdk-denial', 'approval-existing', 'approval-preparation'])
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
history = [] if args.scenario.startswith('approval-') else [('continuous-tasks:activation',{'version':1,'enabled':True}),('continuous-tasks:snapshot',board),('continuous-tasks:supervisor',owner)]
for i, (kind, value) in enumerate(history):
    entry = {'type':'custom','id':f'old-{i}','parentId':parent,'timestamp':now,'customType':kind,'data':value}
    records.append(entry); parent = entry['id']
seed = ''.join(json.dumps(row,separators=(',',':'))+'\n' for row in records).encode()
path.write_bytes(seed)
env = {k:v for k,v in os.environ.items() if not k.startswith(('PI_SESSION_', 'PI_SUBAGENT', 'PI_INTERCOM', 'PI_SUPERVISOR'))}
if args.scenario.startswith('approval-'):
    env.update(GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL=os.devnull)
    subprocess.run(['git','init','-q',str(sandbox)],check=True,env=env)
    (sandbox/'.gitignore').write_text('*\n!.gitignore\n!input.txt\n!test_output.py\n!result.txt\n!owned-checker/\n!owned-checker/test_output.py\n')
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
contract_ui_checks = 0
def text():
    return ansi.sub(b'', bytes(data)).decode('utf8', 'replace')
def receive(pattern, timeout=40):
    deadline = min(overall_deadline, time.monotonic()+timeout)
    while time.monotonic() < deadline:
        match = re.search(pattern, text())
        if match and (data.rfind(b'\x1b[?2026h') <= data.rfind(b'\x1b[?2026l')):
            return match
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
def answer(kind, already_selected=False):
    global stage, contract_ui_checks
    stage = 'native draft and scope review '+kind
    receive('需要你回应|只读核对|格式化浏览|集中审核|契约定义审核')
    if '契约定义审核' in text():
        assert 'Enter 绑定当前定义' in text() and 'r 不绑定' in text() and 'Esc 稍后' in text()
        assert '选项 1' not in text() and '选项 2' not in text()
        for geometry in [None, (30,100)]:
            if geometry:
                fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',*geometry,0,0)); os.kill(pid,signal.SIGWINCH)
                data.clear(); receive('材料未完整核对')
                send('\r'); receive('本次没有绑定')
            for _ in range(128):
                if '完整材料已核对' in text(): break
                send('\x1b[6~'); receive(r'材料\s+\d+/\d+|完整材料已核对')
            else: raise AssertionError('manual contract material never completed')
        contract_ui_checks += 1
        (sandbox/'contract-definition-complete.txt').write_text(text())
        send('\r')
        return
    if '集中审核' in text():
        if not already_selected and '必需权限已齐' not in text():
            send('a'); receive(r'必需权限已齐|完整材料已核对|Enter 批准')
        for _ in range(128):
            if '完整材料已核对' in text(): break
            send('\x1b[6~'); receive(r'材料\s+\d+/\d+|完整材料已核对')
        else: raise AssertionError('bundled native material never completed')
        send('\r')
        return
    if '需要你回应' in text():
        if args.decision_layouts: card_layouts()
        send('\x1b[B'); receive('→.*(?:允许上述范围|开始执行|选项 1)')
        send('\x1bOQ'); receive('只读核对')
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
    command('/goal-native-probe '+label)
    artifact=sandbox/(label+'.json'); deadline=time.monotonic()+15
    while not artifact.exists() and time.monotonic()<deadline:
        ready,_,_=select.select([fd],[],[],0.05)
        if ready:
            chunk=os.read(fd,65536);data.extend(chunk);log.write(chunk);log.flush()
    assert artifact.is_file(), 'Native read-only probe did not produce its actual artifact: '+label
    value = json.loads(artifact.read_text())
    assert value['stdinTty'] and value['stdoutTty'] and value['mode']=='tui' and not value['nativeSourceMocked']
    assert pathlib.Path(value['sessionFile']).resolve() == path
    assert pathlib.Path(value['argv1']).resolve() == cli
    value['probeArtifact']=str(artifact)
    return value
def wait_probe(label, predicate):
    deadline = time.monotonic()+25
    for attempt in range(80):
        value = probe(label+'-'+str(attempt))
        if predicate(value): return value
        if time.monotonic() > deadline: break
        time.sleep(0.05)
    raise AssertionError('Actual native state never reached '+label+': '+json.dumps(value.get('supervisor')))
def goal_records(value):
    return [row for row in value['entries'] if row.get('customType')=='continuous-tasks:supervisor' and row['data'].get('version')==5]
def selected(value):
    return [row for row in goal_records(value) if row['data']['kind']=='transition-committed'][-1]
def current_preflight(value):
    if not any(row['data']['kind']=='transition-committed' for row in goal_records(value)):
        stored=[row['data'] for row in value['entries'] if row.get('customType')=='continuous-tasks:preflight'][-1]
        return stored.get('snapshot',stored)
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
    if args.scenario.startswith('approval-'):
        command('/task-supervisor preflight Owned native first workflow')
    else:
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
    elif args.scenario.startswith('approval-'):
        prepare = args.scenario == 'approval-preparation'
        if not prepare:
            stage = 'unread native bundle must not submit'
            receive('集中审核'); send('\r'); receive('请先用 PgDn')
            send('\x1b'); receive('GOAL_NATIVE_IDLE_1')
            deferred = probe('deferred')
            assert 'approval' not in current_preflight(deferred) and 'started' not in current_preflight(deferred)
            assert not any(row.get('customType')=='continuous-tasks:preflight-control' for row in deferred['entries'])
            command('/task-supervisor approve'); receive('集中审核')
            # Actual terminal geometry changes invalidate reading, not the local selection.
            if '必需权限已齐' not in text():
                send('a'); receive(r'必需权限已齐|完整材料已核对|Enter 批准')
            fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0)); os.kill(pid,signal.SIGWINCH)
            data.clear(); receive('材料未完整核对')
        answer('consolidated permissions and definitions', already_selected=not prepare)
        if prepare: receive('GOAL_NATIVE_IDLE_1')
        approved = probe('approved')
        original = current_preflight(approved)
        assert original['phase']=='approved' and 'started' not in original
        assert not (sandbox/'result.txt').exists()
        assert not approved.get('supervisor')
        command('/task-supervisor start'); answer('independent first Start')
        if prepare:
            receive('GOAL_NATIVE_IDLE_2')
            prepared=wait_probe('prepared',lambda value:value.get('supervisor',{}).get('status')=='paused' and not value['supervisor'].get('pending'))
            assert prepared['board']['workflowStatus']=='inactive' and len(prepared['board']['tasks'])==1
            assert not prepared.get('acceptance',{}).get('contracts') and not (sandbox/'result.txt').exists()
            proposal_id=original['proposal']['contractProposalId']
            stage='manual contract single document at SSH geometry'
            fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0)); os.kill(pid,signal.SIGWINCH)
            command('/task-supervisor review-contract '+proposal_id); receive('契约定义审核')
            assert 'Enter 绑定当前定义' in text() and 'r 不绑定' in text() and 'Esc 稍后' in text()
            (sandbox/'contract-definition-first-80x24.txt').write_text(text())
            send('\r'); receive('本次没有绑定')
            send('\x1b'); receive('契约仍未绑定.*deferred'); deferred_contract=probe('contract-deferred')
            assert not deferred_contract.get('acceptance',{}).get('contracts') and not deferred_contract.get('acceptance',{}).get('contractReviews')
            assert deferred_contract['supervisor']==prepared['supervisor'] and current_preflight(deferred_contract)['approval']==original['approval']
            command('/task-supervisor review-contract '+proposal_id); receive('契约定义审核')
            send('r'); receive('契约仍未绑定.*declined'); declined_contract=probe('contract-declined')
            assert not declined_contract['acceptance']['contracts'] and len(declined_contract['acceptance']['contractReviews'])==1
            assert declined_contract['acceptance']['contractReviews'][0]['control']['data']['value']=='不绑定'
            assert declined_contract['supervisor']==prepared['supervisor'] and current_preflight(declined_contract)['approval']==original['approval']
            command('/task-supervisor review-contract '+proposal_id); answer('only prepared definitions')
            assert contract_ui_checks==1
            reviewed=probe('reviewed')
            assert reviewed['supervisor']['status']=='paused'
            assert reviewed['supervisor']['reviews']==prepared['supervisor']['reviews']
            assert current_preflight(reviewed)['approval']==original['approval']
            assert len(reviewed['acceptance']['contracts'])==1
            command('/task-supervisor recover')
        receive('GOAL_NATIVE_IDLE_'+('3' if prepare else '2'))
        final=wait_probe('completed',lambda value:value.get('supervisor',{}).get('status')=='completed')
        assert final['board']['workflowStatus']=='completed'
        assert (sandbox/'result.txt').read_text()=='made\n'
        assert current_preflight(final)['approval']==original['approval']
        controls=[row['data'] for row in final['entries'] if row.get('customType')=='continuous-tasks:preflight-control']
        assert sum(row['kind']=='approve' for row in controls)==1 and sum(row['kind']=='start' for row in controls)==1
        assert sum(row['kind']=='define' for row in controls)==0
        contracts=final['acceptance']['contracts']
        assert len(contracts)==1 and contracts[0]['data']['authority']['kind']==('native-reviewed' if prepare else 'preflight-reviewed')
        runs=final['acceptance']['runs']; assert len(runs)==1
        observed=runs[0]['observed']['data']
        assert observed['closed'] and observed['exitCode']==0 and observed['pid']>0 and observed['termination']=='exited'
        assert observed['temporary']['cleanup']=='removed' and not pathlib.Path(observed['temporary']['root']).exists()
        assert observed['result']['tests']==1 and observed['result']['passed']==1
        assert observed['invocation']['profile']['id']=='python-unittest-v1'
        assert final.get('stateFromPublishedJournal')
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
    report = {'result':'PASS','scenario':args.scenario,'sourceQualifiedSyntheticTaskCompletion':args.scenario.startswith('approval-'),'source':str(source),'actualCli':str(cli),'nativeSourceMocked':False,'syntheticKeystrokes':True,'businessExecutionCertified':False,'decisionLayoutChecks':layout_checks,'manualContractDocumentChecks':contract_ui_checks,'settingsUnchanged':True,'originalHistoryBytesUnchanged':True,'probe':final.get('probeArtifact',str(sandbox/'final.json')),'sessionFile':str(path),'transcript':str(transcript)}
    (sandbox/'verified.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report), flush=True)
finally:
    log.close()
    try: os.kill(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    try: os.waitpid(pid, 0)
    except ChildProcessError: pass
    os.close(fd)
