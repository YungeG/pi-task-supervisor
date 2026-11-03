#!/usr/bin/env python3
"""Offline actual CLI/PTY lifecycle checks; synthetic keys are not human identity proof."""
import argparse, errno, fcntl, hashlib, json, os, pathlib, pty, re, select, shutil, signal, struct, subprocess, tempfile, termios, time, uuid

parser = argparse.ArgumentParser()
parser.add_argument('scenario', choices=['sequential', 'permissions', 'information', 'human-interaction', 'sdk-denial', 'approval-existing', 'approval-preparation', 'approval-scope', 'approval-resource', 'approval-guidance', 'final-guidance'])
parser.add_argument('--source', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent.parent)
parser.add_argument('--cli', type=pathlib.Path)
parser.add_argument('--out', type=pathlib.Path)
parser.add_argument('--decision-layouts', action='store_true', help='exercise optional Markdown reading and wide split without submitting')
parser.add_argument('--default-builtin',action='store_true',help='keep the real default builtin codemode loaded and active')
parser.add_argument('--human-cancel-after-start',action='store_true',help='owned ordinary EventBus input after physical Start projection')
parser.add_argument('--human-prepare-failure',action='store_true',help='owned post-ACK preparation failure, no provider work')
parser.add_argument('--human-projection-failure',action='store_true',help='owned deferred tool setter failure before kernel start')
parser.add_argument('--human-joint-resume',action='store_true',help='owned compile checkpoint ordinary user-pause followed by independent native joint resume')
parser.add_argument('--human-choice',action='store_true',help='owned native B choice instead of integer information')
parser.add_argument('--human-controls',action='store_true',help='exercise the qualified B path without approval commands; requires actual H0 module pairing')
parser.add_argument('--container-only',action='store_true',help='verify unsupported default-models container-only profile blocks before first Start')
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
history = [] if args.scenario.startswith('approval-') or args.scenario=='final-guidance' else [('continuous-tasks:activation',{'version':1,'enabled':True}),('continuous-tasks:snapshot',board),('continuous-tasks:supervisor',owner)]
for i, (kind, value) in enumerate(history):
    entry = {'type':'custom','id':f'old-{i}','parentId':parent,'timestamp':now,'customType':kind,'data':value}
    records.append(entry); parent = entry['id']
seed = ''.join(json.dumps(row,separators=(',',':'))+'\n' for row in records).encode()
path.write_bytes(seed)
env = {k:v for k,v in os.environ.items() if not k.startswith(('PI_SESSION_', 'PI_SUBAGENT', 'PI_INTERCOM', 'PI_SUPERVISOR'))}
if args.scenario.startswith('approval-') or args.scenario=='final-guidance':
    env.update(GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL=os.devnull)
    subprocess.run(['git','init','-q',str(sandbox)],check=True,env=env)
    (sandbox/'.gitignore').write_text('*\n!.gitignore\n!input.txt\n!test_output.py\n!result.txt\n!owned-checker/\n!owned-checker/test_output.py\n')
if args.scenario=='final-guidance':
    env.update(OWNED_HOST_MODULE_GOAL='Validate only owned nonempty input; no business execution',OWNED_HOST_MODULE_SESSION=session_id)
env.update(PI_CODING_AGENT_DIR=str(sandbox/'agent'), PI_OFFLINE='1', PI_SKIP_VERSION_CHECK='1', PI_TELEMETRY='0', TERM='xterm-256color', GOAL_NATIVE_SCENARIO=args.scenario, GOAL_NATIVE_OUT=str(sandbox))
if args.human_controls:
    env['GOAL_NATIVE_HUMAN_CONTROLS']='1'
if args.human_joint_resume:
    assert args.human_controls and args.scenario=='approval-existing'
    env['GOAL_NATIVE_JOINT_RESUME']='1'
if args.human_choice:
    assert args.human_controls and args.scenario=='information'
    env['GOAL_NATIVE_CHOICE']='1'
if args.human_cancel_after_start:
    assert args.human_controls
    env['GOAL_NATIVE_CANCEL_AFTER_START']='1'
if args.human_prepare_failure:
    assert args.human_controls
    env['GOAL_NATIVE_PREPARE_FAILURE']='1'
if args.human_projection_failure:
    assert args.human_controls
    env['GOAL_NATIVE_PROJECTION_FAILURE']='1'
if args.scenario == 'human-interaction':
    env['PI_TASK_SUPERVISOR_PENDING_KEY']='ctrl+shift+y'
argv = [node, str(cli), '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '-e', str(source/'test/goal-native-fixture.ts'), '--model', 'goal-native-fixture/test', '--session', str(path), '--session-dir', str(sandbox/'sessions')]
if args.default_builtin:
    argv.remove('--no-extensions');argv.extend(['--tools','+codemode'])
if args.container_only:
    assert args.default_builtin and args.scenario.startswith('approval-')
    (sandbox/'agent').mkdir(exist_ok=True)
    (sandbox/'agent/settings.json').write_text(json.dumps({'codemode':{'mode':'only'}}))
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
    receive('需要你回应|只读核对|格式化浏览|集中审核|契约定义审核|范围修订审核')
    if '范围修订审核' in text():
        assert 'Enter 批准本版修订' in text() and 'r 拒绝本版' in text() and 'Esc 稍后' in text()
        for geometry in [None,(30,100)]:
            if geometry:
                fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',*geometry,0,0)); os.kill(pid,signal.SIGWINCH)
                data.clear();receive('材料未完整核对');send('\r');receive('本次没有提交')
            for _ in range(128):
                if '完整材料已核对' in text(): break
                send('\x1b[6~'); receive(r'材料\s+\d+/\d+|完整材料已核对')
            else: raise AssertionError('scope revision material never completed')
        (sandbox/'scope-revision-complete.txt').write_text(text())
        send('\r')
        return
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
recovery_reviews = []
def confirm_recovery(effect, revision=None):
    global stage
    stage='B complete readonly recovery material, then separate native final choice'
    receive('只读核对');pages=[]
    for _ in range(128):
        pages.append(text());send('\r')
        match=receive(r'(恢复材料已完整核对)|(第\s*\d+/\d+\s*页)')
        if match.group(1): break
    else: raise AssertionError('Recovery material never completed')
    material='\n'.join(pages)
    for required in ['恢复控制材料','本次精确效果','generation','digest','owner','Supervisor','scope','reviews','执行结算']:
        assert required in material, 'Recovery material missing '+required
    flat=re.sub(r'[\s·]','',material)
    assert {'joint':'联合解除普通user_pause','board-only':'仅恢复看板','recover':'原Supervisorrecover'}[effect] in flat
    if revision: assert revision['entryId'] in flat and revision['digest'] in flat and '"recoveryRequired":true' in flat
    artifact=sandbox/('recovery-material-'+str(len(recovery_reviews)+1)+'.txt');artifact.write_text(material);recovery_reviews.append(str(artifact))
    receive('确认执行这一恢复控制');send('\x1b[B\r')
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
    if args.default_builtin:
        assert len(initial['codemode'])==1 and initial['codemode'][0]['sourceInfo']['path']=='builtin:codemode' and initial['codemode'][0]['modelsAdvertised']
    if args.scenario == 'final-guidance':
        stage='actual native fixed Bash validation and completed-task review failure'
        command('Exercise only the owned trusted-host final-validation mechanism')
        receive('GOAL_NATIVE_IDLE_1')
        completed=wait_probe('final-completed-fault',lambda value:value.get('board',{}).get('workflowStatus')=='completed' and value.get('supervisor',{}).get('status')=='fault')
        original_board=completed['board'];original_bindings=completed['supervisor']['bindings']
        (sandbox/'input.txt').write_text('second owned nonempty input\n')
        command('/task-supervisor retry-review');receive('Main未排队')
        registered=probe('final-registered')
        registrations=[row for row in registered['entries'] if row.get('customType')=='continuous-tasks:control-facts' and row['data'].get('kind')=='final-validation-registered']
        assert len(registrations)==1
        calls=registered['modelCalls']
        command('/task-supervisor retry-review');receive('Main未排队')
        repeated=probe('final-registration-idempotent')
        assert repeated['modelCalls']==calls
        assert sum(row.get('customType')=='continuous-tasks:control-facts' and row['data'].get('kind')=='final-validation-registered' for row in repeated['entries'])==1
        command('Only read the original current Goal final-validation-registered and run its exact validation; do not recover or replay tasks')
        receive('GOAL_FINAL_NEW_VALIDATION_RECORDED');receive('GOAL_NATIVE_IDLE_2')
        observed=probe('final-new-validation')
        new_proofs=[row for row in observed['entries'] if row.get('customType')=='continuous-tasks:control-facts' and row['data'].get('kind')=='final-validation' and row['data'].get('receiptId')=='tool:new-final-native-proof']
        assert len(new_proofs)==1 and new_proofs[0]['data'].get('validationOnly')
        command('/task-supervisor retry-review')
        final=wait_probe('final-accepted',lambda value:value.get('supervisor',{}).get('status')=='completed')
        assert final['board']==original_board and final['supervisor']['bindings']==original_bindings
        assert sha(settings)==before
        report={'result':'PASS','scenario':'final-guidance','actualCli':str(cli),'trustedHostModuleFixture':True,'nativeBusinessApproval':False,'actualCommandDispatch':True,'actualBashProcess':True,'oneRegistration':True,'registrationDidNotQueueMain':True,'explicitMainValidationOnlyTurn':True,'originalBoardAndBindingsUnchanged':True,'noBusinessAcceptanceCertified':True,'defaultBuiltin':args.default_builtin,'settingsUnchanged':True,'sessionFile':str(path),'transcript':str(transcript),'probe':final['probeArtifact']}
        (sandbox/'verified.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True)
        raise SystemExit(0)
    if args.scenario == 'human-interaction':
        stage = 'native readonly pending shortcut on retained stopped history'
        first=probe('human-a-before-shortcut');assert first['modelCalls']==0
        before_shortcut=sha(path)
        send('\x1b[121;6u');receive('确认与回应')
        send('\x1b');receive('总览')
        send('\x1b');receive('GOAL_NATIVE_UI_CLOSED')
        after_shortcut=probe('human-a-after-shortcut')
        assert sha(path)==before_shortcut and after_shortcut['entries']==first['entries']
        assert after_shortcut['modelCalls']==0
        stage='native explicit later diagnostic'
        command('/goal-native-diagnostic');receive('需要你回应')
        send('\r');receive('GOAL_NATIVE_DIAGNOSTIC_user_deferred')
        later=json.loads((sandbox/'diagnostic-1.json').read_text())
        assert later['status']=='deferred' and later['interaction']=={'phase':'response','code':'user_deferred'}
        stage='native unexplained cancel diagnostic'
        command('/goal-native-diagnostic');receive('需要你回应')
        send('\x1b');receive('GOAL_NATIVE_DIAGNOSTIC_no_response')
        cancelled=json.loads((sandbox/'diagnostic-2.json').read_text())
        assert cancelled['status']=='deferred' and cancelled['interaction']['code']=='no_response'
        final=probe('human-a-final')
        controls=[row for row in final['entries'] if row.get('customType') in ['continuous-tasks:preflight-control','continuous-tasks:human-readback'] or (row.get('customType')=='continuous-tasks:event' and row['data'].get('type') in ['resolve_decision','resume_user'])]
        assert not controls and final['modelCalls']==0 and sha(settings)==before and path.read_bytes().startswith(seed)
        report={'result':'PASS','scenario':'human-interaction','actualCli':str(cli),'nativeSourceMocked':False,'syntheticKeystrokes':True,'businessExecutionCertified':False,'readonlyShortcut':True,'readonlyShortcutJournalUnchanged':True,'nativeDiagnosticCodes':['user_deferred','no_response'],'noHumanControlsOrWitnesses':True,'noExtraModelCalls':True,'settingsUnchanged':True,'originalHistoryBytesUnchanged':True,'probe':str(sandbox/'human-a-final.json'),'sessionFile':str(path),'transcript':str(transcript)}
        (sandbox/'verified.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True)
        raise SystemExit(0)
    if args.scenario == 'information':
        if args.human_controls:
            command('/task-supervisor tasks-only');receive('Task-board-only')
            command('/goal-native-pending-info');receive('GOAL_NATIVE_PENDING_READY')
            send('\x1b[121;6u');receive('需要你回应')
        if args.human_choice:
            answer('original finite business choice');receive('答案已保存')
        else:
            stage = 'native same-screen information input'
            if not args.human_controls: command('/goal-native-information'); receive('需要你回应')
            send('42'); receive('42')
            send('\x1bOS'); receive('格式化浏览')
            send('\x1b'); receive('A 会话卡')
            send('\x1bOR'); receive('C 双栏')
            send('\t'); receive('焦点：完整原文')
            send('\r'); receive('完整原文已核对')
            send('\r'); receive('补充信息（全文已核对）')
            send('\x1b[B\r'); receive('答案已保存' if args.human_controls else 'GOAL_NATIVE_INFORMATION_SAVED')
        final = probe('information-final')
        controls=[row for row in final['entries'] if row.get('customType')=='continuous-tasks:event' and row['data'].get('type')=='resolve_decision']
        assert len(controls)==1 and controls[0]['data']['answer']==('保留原方案' if args.human_choice else '42') and controls[0]['data']['outcome']=='answer'
        witnesses=[row for row in final['entries'] if row.get('customType')=='continuous-tasks:human-readback']
        assert len(witnesses)==1 and witnesses[0]['data']['controlEntryId']==controls[0]['id']
        assert final['modelCalls']==0 and sha(settings)==before and path.read_bytes().startswith(seed)
        report={'result':'PASS','scenario':'choice' if args.human_choice else 'information','source':str(source),'actualCli':str(cli),'nativeSourceMocked':False,'syntheticKeystrokes':True,'businessExecutionCertified':False,'answer':'保留原方案' if args.human_choice else '42','sameScreenInput':not args.human_choice,'readonlyReturnPreservedDraft':True,'wideSourceReview':True,'nativeFinalConfirmed':True,'settingsUnchanged':True,'originalHistoryBytesUnchanged':True,'probe':str(sandbox/'information-final.json'),'sessionFile':str(path),'transcript':str(transcript)}
        (sandbox/'verified.json').write_text(json.dumps(report,indent=2)+'\n'); print(json.dumps(report),flush=True)
        raise SystemExit(0)
    stage = 'native archive-and-plan'
    if args.scenario.startswith('approval-'):
        command('/task-supervisor supervise Owned native first workflow')
    else:
        command('/task-supervisor supervise Owned native next goal'); answer('archive')
    if args.scenario == 'sequential':
        stage = 'first readonly planning'; receive('GOAL_NATIVE_IDLE_1'); first = probe('first')
        gid = first['currentGoalRunId']; assert all(row['data'].get('supervisor') is None for row in goal_records(first) if row['data']['kind']=='goal-state')
        command('/task-supervisor supervise --replan'); stage = 'same-goal explicit planning'; receive('GOAL_NATIVE_IDLE_2'); replanned = probe('replanned')
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
    elif args.human_controls and args.scenario in ['approval-existing','approval-preparation','approval-scope']:
        stage='B original permission and separate automatic first Start'
        answer('consolidated permissions and definitions')
        answer('independent automatic first Start')
        if args.human_cancel_after_start or args.human_prepare_failure or args.human_projection_failure:
            stage='B saved Start cancellation or post-ACK preparation failure'
            receive('GOAL_NATIVE_IDLE_2')
            held=probe('human-saved-held')
            assert held['ownedHumanFault'] and current_preflight(held).get('started')
            assert held['supervisor']['status'] in ['paused','fault'] and not (sandbox/'result.txt').exists()
            controls=[row['data'] for row in held['entries'] if row.get('customType')=='continuous-tasks:preflight-control']
            assert sum(row['kind']=='start' for row in controls)==1 and sum(row['kind']=='approve' for row in controls)==1
            dispatches=[row for row in held['entries'] if row.get('type')=='custom_message' and row.get('customType')=='continuous-tasks:continue']
            assert len(dispatches)==(1 if args.human_projection_failure else 0)
            failures=[row['failure'] for row in held['ownedHumanEvents'] if row.get('failure')]
            if args.human_prepare_failure:
                assert len(failures)==1 and failures[0]['status']=='started' and failures[0]['sessionId']==session_id
            else: assert not failures
            if args.human_projection_failure:
                assert len([row for row in held['ownedHumanEvents'] if row['type']=='agent_start'])==2
                assert [row for row in held['ownedHumanEvents'] if row['type']=='agent_settled'][-1]['aborted'] is True
            assert held['modelCalls']==(3 if args.human_prepare_failure or args.human_projection_failure else 4)
            rows=[json.loads(line) for line in path.read_text().splitlines()]
            business=[part for row in rows if row.get('type')=='message' and row.get('message',{}).get('role')=='assistant' for part in row['message'].get('content',[]) if part.get('type')=='toolCall' and part.get('name') in ['write_tasks','compile_tasks','write','run_check']]
            assert not business and sha(settings)==before
            report={'result':'PASS','scenario':'human-projection-failure' if args.human_projection_failure else 'human-prepare-failure' if args.human_prepare_failure else 'human-saved-cancel','actualCli':str(cli),'resolvedCodingAgent':held['resolvedCodingAgent'],'h0Version':held['h0Version'],'savedStartRetained':True,'oneStartNoReplay':True,'noBusinessEffect':True,'noApprovalCommands':True,'nativeSourceMocked':False,'settingsUnchanged':True,'probe':held['probeArtifact'],'sessionFile':str(path),'transcript':str(transcript)}
            (sandbox/'verified.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True);raise SystemExit(0)
        if args.human_joint_resume:
            receive('GOAL_NATIVE_COMPILE_CHECKPOINT')
            command('/task-supervisor pause Owned ordinary user pause');receive('Main未排队')
            paused=probe('human-ordinary-user-pause')
            assert paused['ownedHumanPause'] and paused['board']['workflowStatus']=='paused' and paused['supervisor']['holdCause']=='user_pause'
            assert not (sandbox/'result.txt').exists()
            spent={key:paused['supervisor'][key] for key in ['reviews','continuations','tokens','cost']}
            send('\x1b[121;6u');confirm_recovery('joint')
        elif args.scenario=='approval-preparation':
            stage='B automatic prepared concrete definition review'
            receive('契约定义审核'); answer('only prepared definitions, no recovery')
            receive('具体定义：bound')
            reviewed=probe('human-definition-reviewed')
            assert reviewed['supervisor']['status']=='paused' and len(reviewed['acceptance']['contracts'])==1
            assert not (sandbox/'result.txt').exists()
            saved_start=current_preflight(reviewed)['started']
            spent={key:reviewed['supervisor'][key] for key in ['reviews','continuations','tokens','cost']}
            send('\x1b[121;6u');confirm_recovery('recover')
        elif args.scenario=='approval-scope':
            receive('GOAL_NATIVE_IDLE_2')
            held=probe('human-scope-held')
            command('Keep this Goal paused. Submit exact owned scope metadata only with reason; preserve original permissions, prohibitions and preparation. No recover or business work.')
            stage='B automatic exact scope review'
            receive('范围修订审核');answer('scope only, no adoption or recovery')
            receive('范围元数据：committed')
            reviewed=probe('human-scope-reviewed')
            assert len(reviewed['acceptance']['scopeCommits'])==1 and reviewed['supervisor']==held['supervisor']
            assert reviewed['board']==held['board'] and current_preflight(reviewed)==current_preflight(held)
            assert not (sandbox/'result.txt').exists()
            command('/task-supervisor pause Keep independent stronger hold');receive('Main未排队')
            paused=probe('human-board-paused')
            send('\x1b[121;6u');confirm_recovery('board-only');receive('Task board resumed only')
            board_only=probe('human-board-only-resumed')
            assert board_only['supervisor']==paused['supervisor'] and board_only['board']['workflowStatus']=='active'
            send('\x1b[121;6u');confirm_recovery('recover',reviewed['acceptance']['scopeCommits'][-1])
        receive('GOAL_NATIVE_IDLE_'+('4' if args.scenario=='approval-scope' else '3' if args.scenario=='approval-preparation' or args.human_joint_resume else '2'))
        final=wait_probe('human-completed',lambda value:value.get('supervisor',{}).get('status')=='completed')
        controls=[row['data'] for row in final['entries'] if row.get('customType')=='continuous-tasks:preflight-control']
        assert sum(row['kind']=='approve' for row in controls)==1 and sum(row['kind']=='start' for row in controls)==1
        assert final['h0Version']==1 and pathlib.Path(final['resolvedCodingAgent'].removeprefix('file://')).resolve().is_relative_to(cli.parent.parent)
        assert final['board']['workflowStatus']=='completed' and (sandbox/'result.txt').read_text()=='made\n'
        if args.scenario=='approval-preparation':
            assert current_preflight(final)['started']==saved_start
            assert all(final['supervisor'][key]>=spent[key] for key in spent)
        if args.scenario=='approval-scope':
            commit=final['acceptance']['scopeCommits'][0]
            assert final['supervisor']['scopeRevisionRef']=={'entryId':commit['entryId'],'digest':commit['digest']}
        verify_native_commits(final)
        report={'result':'PASS','scenario':'human-complete','source':str(source),'actualCli':str(cli),'resolvedCodingAgent':final['resolvedCodingAgent'],'h0Version':final['h0Version'],'noApprovalCommands':True,'onePermissionAndSeparateStart':True,'jointResume':args.human_joint_resume,'recoveryMaterialArtifacts':recovery_reviews,'nativeSourceMocked':False,'syntheticKeystrokes':True,'businessExecutionCertified':False,'settingsUnchanged':sha(settings)==before,'probe':final['probeArtifact'],'sessionFile':str(path),'transcript':str(transcript)}
        assert report['settingsUnchanged']
        (sandbox/'verified.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True)
        raise SystemExit(0)
    elif args.scenario.startswith('approval-'):
        prepare = args.scenario == 'approval-preparation'
        guidance = args.scenario == 'approval-guidance'
        resource = args.scenario == 'approval-resource'
        scope = args.scenario in ['approval-scope','approval-guidance','approval-resource']
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
        if args.container_only:
            command('/task-supervisor start');receive('Formal evidence route unsupported')
            denied=probe('unsupported-before-start')
            assert 'started' not in current_preflight(denied) and not denied.get('supervisor')
            assert denied['modelCalls']==approved['modelCalls'] and not (sandbox/'result.txt').exists()
            assert not any(row.get('customType')=='continuous-tasks:preflight-control' and row['data'].get('kind')=='start' for row in denied['entries'])
            assert sha(settings)==before
            report={'result':'PASS','scenario':'unsupported-before-start','actualCli':str(cli),'defaultBuiltin':True,'modelsEnabledCodemodePresent':True,'noFirstStart':True,'noBusinessDispatch':True,'settingsUnchanged':True,'nativeSourceMocked':False,'syntheticKeystrokes':True,'probe':str(sandbox/'unsupported-before-start.json'),'sessionFile':str(path),'transcript':str(transcript)}
            (sandbox/'verified.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True)
            raise SystemExit(0)
        if guidance:
            stage='known changed-definition blocker before first Start'
            with (sandbox/'test_output.py').open('a') as output: output.write('\n# owned changed definition requires a fresh definition response\n')
            command('/task-supervisor start');receive('Checker definitions changed after approval')
            blocked=probe('definition-blocked')
            assert 'started' not in current_preflight(blocked)
            command('/task-supervisor status');receive('Next preflight actor:')
            assert 'Next preflight: /task-supervisor start' not in text()
            (sandbox/'definition-blocked-status.txt').write_text(text())
            command('/task-supervisor approve');answer('changed definitions only',already_selected=True)
            defined=probe('definition-reviewed')
            assert current_preflight(defined)['approval']==original['approval']
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
        if scope:
            receive('GOAL_NATIVE_IDLE_2')
            held=wait_probe('scope-original-held',lambda value:value.get('supervisor',{}).get('status')=='paused' and not value['supervisor'].get('pending'))
            if guidance:
                results=[row for row in path.read_text().splitlines() if 'native-active-scope-denied' in row]
                assert any('SCOPE_NOT_HELD' in row for row in results)
                calls=held['modelCalls']
                command('/task-supervisor pause Explicit scope metadata only');receive('Main未排队')
                paused=probe('explicit-metadata-pause')
                assert paused['modelCalls']==calls and paused['supervisor']['status']=='paused'
                held=paused
            stage='real model metadata proposal while actual Main is running and Goal held'
            command('Keep this Goal paused. Submit exact owned scope metadata only with reason; preserve original permissions, prohibitions and preparation. No recover or business work.')
            receive('GOAL_NATIVE_SCOPE_PROPOSED'); receive('GOAL_NATIVE_IDLE_3')
            proposed=probe('scope-proposed')
            assert len(proposed['acceptance']['scopeProposals'])==1 and not proposed['acceptance']['scopeCommits']
            assert proposed['supervisor']==held['supervisor'] and not (sandbox/'result.txt').exists()
            proposal_id=proposed['acceptance']['scopeProposals'][0]['data']['proposalId']
            if resource:
                rows=[json.loads(line) for line in path.read_text().splitlines()]
                results={row['message']['toolCallId']:row['message'] for row in rows if row.get('type')=='message' and row.get('message',{}).get('role')=='toolResult'}
                denied=results['native-postcompile-contract-denied'];assert denied.get('isError') and 'propose_scope_revision' in json.dumps(denied)
                repeated=results['native-scope-repeat'];assert not repeated.get('isError')
                repeated=json.loads(next(part['text'] for part in repeated['content'] if part['type']=='text'))
                assert repeated['reused'] and repeated['proposalId']==proposal_id
                capacity=results['native-scope-capacity-denied'];assert capacity.get('isError') and '16KiB' in json.dumps(capacity)
                proposals=[row for row in proposed['entries'] if row.get('customType')=='continuous-tasks:acceptance-proposal']
                assert len(proposals)==2, 'ordinary postcompile/capacity failures and pending duplicate must not add contract metadata'
                submitted=proposed['acceptance']['scopeProposals'][0]['data']['plan']['permissions'][0]['limits']
                assert '600 seconds/256 MiB' in submitted and 'unknown' in submitted and '120 seconds/64 MiB' in original['proposal']['permissions'][0]['limits']
            fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0)); os.kill(pid,signal.SIGWINCH)
            command('/task-supervisor review-scope '+proposal_id);receive('范围修订审核')
            send('\r');receive('本次没有提交');send('\x1b');receive('范围记录：deferred')
            deferred_scope=probe('scope-deferred');assert not deferred_scope['acceptance']['scopeReviews']
            command('/task-supervisor review-scope '+proposal_id);answer('exact scope amendment, not original business approval or Start')
            if guidance:
                receive('CONTROL_JOURNAL_UNCERTAIN')
                partial=probe('scope-binding-gap')
                assert partial['ownedScopeWriteFailed'] and not partial['acceptance']['scopeCommits']
                with (sandbox/'test_output.py').open('a') as output: output.write('\n# owned material changed after original native response\n')
                command('/task-supervisor repair-scope '+proposal_id);receive('needs_review')
                receive('review-scope')
                (sandbox/'scope-needs-review-notice.txt').write_text(text())
                repaired=probe('scope-needs-review')
                assert not repaired['acceptance']['scopeCommits']
                fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0)); os.kill(pid,signal.SIGWINCH)
                command('/task-supervisor review-scope '+proposal_id);answer('new exact review after changed material; no replayed approval')
            reviewed=probe('scope-reviewed')
            assert len(reviewed['acceptance']['scopeCommits'])==1 and reviewed['supervisor']==held['supervisor']
            assert current_preflight(reviewed)==current_preflight(held) and not (sandbox/'result.txt').exists()
            assert reviewed['board']==held['board']
            if guidance:
                command('/task-supervisor resume');receive('Task board resumed only')
            command('/task-supervisor recover')
        receive('GOAL_NATIVE_IDLE_'+('4' if scope else '3' if prepare else '2'))
        final=wait_probe('completed',lambda value:value.get('supervisor',{}).get('status')=='completed')
        assert final['board']['workflowStatus']=='completed'
        assert (sandbox/'result.txt').read_text()=='made\n'
        assert current_preflight(final)['approval']==original['approval']
        controls=[row['data'] for row in final['entries'] if row.get('customType')=='continuous-tasks:preflight-control']
        assert sum(row['kind']=='approve' for row in controls)==1 and sum(row['kind']=='start' for row in controls)==1
        assert sum(row['kind']=='define' for row in controls)==(1 if guidance else 0)
        contracts=final['acceptance']['contracts']
        assert len(contracts)==(2 if scope else 1) and contracts[-1]['data']['authority']['kind']==('scope-revision-reviewed' if scope else 'native-reviewed' if prepare else 'preflight-reviewed')
        if scope:
            commit=final['acceptance']['scopeCommits'][0]
            expected_ref={'entryId':commit['entryId'],'digest':commit['digest']}
            assert final['supervisor']['scopeRevisionRef']==expected_ref
            assert len(final['acceptance']['scopeReviews'])==(2 if guidance else 1) and final['acceptance']['scopeReviews'][-1].get('witness')
            ledger=[row['data'] for row in final['entries'] if row.get('customType')=='continuous-tasks:receipt-ledger' and row['data'].get('kind')=='receipt']
            assert any(row['receipt']['id']=='tool:native-check' and row['receipt'].get('scopeRevisionRef')==expected_ref and row['capture'].get('scopeRevisionRef')==expected_ref for row in ledger)
            assert final['supervisor']['reviews']>=held['supervisor']['reviews'] and final['supervisor']['continuations']>=held['supervisor']['continuations']
        runs=final['acceptance']['runs']; assert len(runs)==1
        observed=runs[0]['observed']['data']
        assert observed['closed'] and observed['exitCode']==0 and observed['pid']>0 and observed['termination']=='exited'
        assert observed['temporary']['cleanup']=='removed' and not pathlib.Path(observed['temporary']['root']).exists()
        assert observed['result']['tests']==1 and observed['result']['passed']==1
        assert observed['invocation']['profile']['id']=='python-unittest-v1'
        if resource:
            definition_ref=contracts[-1]['data']['definitions'][0]['ref']
            definition=next(d['data'] for d in final['acceptance']['definitions'] if d['entryId']==definition_ref['entryId'] and d['digest']==definition_ref['digest'])
            assert definition['spec']['timeoutMs']==5000 and held['acceptance']['definitions'][0]['data']['spec']['timeoutMs']==1000
            assert runs[0]['start']['data']['definitionRef']==definition_ref
            (sandbox/'resource-proof.json').write_text(json.dumps({'limitsBefore':original['proposal']['permissions'][0]['limits'],'submittedAndAdoptedLimits':submitted,'boundAndExecutedTimeoutMs':definition['spec']['timeoutMs'],'adoptedScopeRef':expected_ref,'missingHistoryStillUnknown':True,'textQuotaIsNotOsEnforcement':True,'oneOriginalApprovalAndStart':True,'sameCountersWhileReviewed':reviewed['supervisor']==held['supervisor'],'duplicateReused':repeated['reused'],'capacityRejectedWithoutNewContract':True,'ordinaryPostcompileRejected':True},indent=2)+'\n')
        assert final.get('stateFromPublishedJournal')
    else:
        answer('required permission')
        stage = 'approved without execution'; receive('GOAL_NATIVE_IDLE_1')
        if args.scenario == 'permissions': receive('待你处理（只读提示）')
        approved = probe('approved')
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
    report = {'result':'PASS','scenario':args.scenario,'sourceQualifiedSyntheticTaskCompletion':args.scenario.startswith('approval-'),'source':str(source),'actualCli':str(cli),'nativeSourceMocked':False,'syntheticKeystrokes':True,'businessExecutionCertified':False,'decisionLayoutChecks':layout_checks,'manualContractDocumentChecks':contract_ui_checks,'scopeDocument80x24AndResizeChecked':args.scenario in ['approval-scope','approval-resource'],'defaultBuiltin':args.default_builtin,'readonlyNoticeObserved':args.scenario=='permissions','settingsUnchanged':True,'originalHistoryBytesUnchanged':True,'probe':final.get('probeArtifact',str(sandbox/'final.json')),'sessionFile':str(path),'transcript':str(transcript)}
    (sandbox/'verified.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report), flush=True)
finally:
    log.close()
    try: os.kill(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    try: os.waitpid(pid, 0)
    except ChildProcessError: pass
    os.close(fd)
