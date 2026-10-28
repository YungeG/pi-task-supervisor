"""Fixed finite unittest profile for reviewed benign checkers, not hostile code.

Only the host supplies stdin. The parent verifies this file's identity, observes
actual process close, and owns cleanup. Nothing here grants business permission.
"""
import contextlib
import importlib.abc
import importlib.util
import io
import inspect
from functools import partial
import json
import os
import posix
import resource
import sqlite3
import _sqlite3
import sys
import tempfile
import unittest


def main():
    cfg = json.load(sys.stdin)
    if sys.platform != "linux" or os.getuid() == 0:
        raise RuntimeError("unqualified finite Python host")
    temporary = os.path.realpath(cfg["temporaryRoot"])
    info = os.lstat(temporary)
    if (temporary != cfg["temporaryRoot"] or os.path.dirname(temporary) != "/tmp"
            or not os.path.basename(temporary).startswith("pi-supervisor-check-")
            or not os.path.isdir(temporary) or info.st_uid != os.getuid()
            or info.st_mode & 0o777 != 0o700):
        raise RuntimeError("temporary directory is not the host-owned profile directory")
    os.environ["TMPDIR"] = temporary
    os.environ["SQLITE_TMPDIR"] = temporary
    tempfile.tempdir = temporary
    seconds = max(1, (cfg["timeoutMs"] + 999) // 1000)
    for kind, limit in ((resource.RLIMIT_CPU, seconds),
                        (resource.RLIMIT_AS, 512 * 1024 * 1024),
                        (resource.RLIMIT_NOFILE, 128),
                        (resource.RLIMIT_NPROC, 0),
                        (resource.RLIMIT_FSIZE, 32 * 1024 * 1024)):
        resource.setrlimit(kind, (limit, limit))
    reads = set(cfg["reads"])
    reads.add(os.path.realpath(__file__))
    stdlib = cfg["stdlibRoot"]
    descriptor_directory = os.path.realpath("/proc/self/fd")
    ancestors = set()
    for filename in reads:
        parent = os.path.dirname(filename)
        while parent != os.path.dirname(parent):
            ancestors.add(parent)
            parent = os.path.dirname(parent)

    def inside(path, root):
        return path == root or path.startswith(root + os.sep)

    def path_of(value, directory=None):
        if isinstance(value, int):
            if value in (0, 1, 2):
                return "@stdio"
            value = os.readlink("/proc/self/fd/" + str(value))
            if value.endswith(" (deleted)"):
                value = value[:-10]
        value = os.fsdecode(value)
        if not os.path.isabs(value) and directory not in (None, -1, -100):
            value = os.path.join(path_of(directory), value)
        return os.path.realpath(value)

    def allowed_read(path):
        standard = inside(path, stdlib) and not any(
            part in ("site-packages", "dist-packages") for part in path.split(os.sep))
        return path == "@stdio" or path in reads or inside(path, temporary) or standard

    def need_write(value, directory=None):
        path = path_of(value, directory)
        if path != "@stdio" and not inside(path, temporary):
            raise PermissionError("finite checker denied out-of-scope write")

    def authorizer(action, first, second, _database, _source):
        if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH):
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_FUNCTION and str(second).lower() in (
                "load_extension", "readfile", "writefile"):
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_PRAGMA and str(first).lower() in (
                "temp_store_directory", "data_store_directory", "writable_schema"):
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    # connect/handle is emitted before Connection.__init__ finishes. Freeze the
    # authorizer only after initialization, including normal custom subclasses.
    original_connect = sqlite3.connect

    class GuardedConnection(sqlite3.Connection):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            super().set_authorizer(authorizer)

        def set_authorizer(self, callback):
            raise PermissionError("finite checker authorizer is fixed")

    def connect(*args, **kwargs):
        factory = kwargs.get("factory", GuardedConnection)
        if not isinstance(factory, type) or not issubclass(factory, GuardedConnection):
            raise PermissionError("finite checker denied unguarded SQLite factory")
        kwargs["factory"] = factory
        return original_connect(*args, **kwargs)

    for module in (sqlite3, sqlite3.dbapi2, _sqlite3):
        module.connect = connect
        module.Connection = GuardedConnection

    def audit(event, args):
        if (event.startswith(("socket.", "subprocess.", "ctypes.", "pty."))
                or event in ("os.system", "os.exec", "os.fork", "os.forkpty",
                             "os.posix_spawn", "os.kill", "os.killpg",
                             "resource.setrlimit", "resource.prlimit",
                             "os.putenv", "os.unsetenv", "sqlite3.load_extension")):
            raise PermissionError("finite checker denied process/network/runtime mutation")
        if event == "import" and str(args[0]).split(".")[0] in (
                "ctypes", "_ctypes", "subprocess", "multiprocessing"):
            raise PermissionError("finite checker denied unsupported import")
        if event == "open":
            path, mode, flags = args
            writable = bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT
                                      | os.O_TRUNC | os.O_APPEND)) or (
                                          isinstance(mode, str) and any(c in mode for c in "wax+"))
            resolved = path_of(path)
            if writable:
                need_write(path)
            elif not allowed_read(resolved) and not (
                    resolved in ancestors and os.path.isdir(resolved)):
                raise PermissionError("finite checker denied undeclared read")
        elif event in ("os.listdir", "os.scandir"):
            path = path_of(args[0] if args and args[0] is not None else os.getcwd())
            if not (inside(path, temporary) or inside(path, stdlib)
                    or path == descriptor_directory):
                raise PermissionError("finite checker denied directory discovery")
        elif event == "sqlite3.connect":
            name = os.fsdecode(args[0])
            if name != ":memory:":
                if name.startswith("file:"):
                    raise PermissionError("finite checker denied SQLite URI")
                need_write(name)
        elif event == "sqlite3.enable_load_extension" and args[1]:
            raise PermissionError("finite checker denied SQLite extension")
        elif event in ("os.remove", "os.rmdir", "os.mkdir", "os.chmod", "os.chown",
                       "os.utime", "os.truncate"):
            index = {"os.remove": 1, "os.rmdir": 1, "os.mkdir": 2,
                     "os.chmod": 2, "os.chown": 3, "os.utime": 3}.get(event)
            need_write(args[0], args[index] if index is not None and len(args) > index else None)
        elif event in ("os.rename", "os.link"):
            need_write(args[0], args[2] if len(args) > 2 else None)
            need_write(args[1], args[3] if len(args) > 3 else None)
        elif event == "os.symlink":
            raise PermissionError("finite checker denied symlink creation")
        elif event == "os.chdir":
            path = path_of(args[0])
            if not (inside(path, temporary) or path in ancestors):
                raise PermissionError("finite checker denied working directory")

    # CPython's open audit tuple omits dir_fd. Resolve a normal os.open dir-fd
    # request to its physical absolute target before the ordinary audit check.
    # This is a benign-checker profile, not an atomic/hostile-code filesystem jail.
    original_open = os.open

    def open_relative(path, flags, mode=0o777, *, dir_fd=None):
        if dir_fd is not None and not os.path.isabs(path):
            if dir_fd < 0:
                raise OSError("finite checker requires a real directory descriptor")
            path = path_of(path, dir_fd)
        return original_open(path, flags, mode)

    os.open = open_relative
    posix.open = open_relative
    os.supports_dir_fd.discard(original_open)
    os.supports_dir_fd.add(open_relative)
    sys.addaudithook(audit)

    class DeclaredModules(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            relative = fullname.replace(".", "/")
            for suffix in (".py", "/__init__.py"):
                name = relative + suffix
                if name in cfg["checkerFiles"]:
                    filename = os.path.join(cfg["checkerRoot"], name)
                    return importlib.util.spec_from_file_location(
                        fullname, filename,
                        submodule_search_locations=[os.path.dirname(filename)]
                        if suffix.startswith("/") else None)
            if any(name.startswith(relative + "/") for name in cfg["checkerFiles"]):
                spec = importlib.util.spec_from_loader(fullname, loader=None, is_package=True)
                spec.submodule_search_locations = []
                return spec
            return None

    sys.meta_path.insert(0, DeclaredModules())
    statuses = {}
    identities = {}

    class Result(unittest.TestResult):
        def startTest(self, test):
            super().startTest(test)
            statuses[identities[id(test)]] = "failed"

        def addSuccess(self, test):
            super().addSuccess(test)
            statuses[identities[id(test)]] = "passed"

        def addSkip(self, test, reason):
            super().addSkip(test, reason)
            statuses[identities[id(test)]] = "skipped"

        def addSubTest(self, test, subtest, error):
            super().addSubTest(test, subtest, error)
            if error is not None:
                statuses[identities[id(test)]] = "failed"

        def addExpectedFailure(self, test, error):
            super().addExpectedFailure(test, error)
            statuses[identities[id(test)]] = "failed"

    class BoundedDiagnostics(io.StringIO):
        def write(self, text):
            if self.tell() + len(text) > 16384:
                raise RuntimeError("finite checker diagnostic output limit")
            return super().write(text)

    def require_synchronous(method):
        if (inspect.iscoroutinefunction(method) or inspect.isgeneratorfunction(method)
                or inspect.isasyncgenfunction(method)):
            raise RuntimeError("only synchronous TestCase methods are supported")

    def call_synchronous(method, /, *args, **kwargs):
        require_synchronous(method)
        value = method(*args, **kwargs)
        if value is not None:
            if inspect.iscoroutine(value):
                value.close()
            raise RuntimeError("TestCase methods must complete, not return a factory or awaitable")

    # Keep unittest's suite/fixture ordering, but make every supported fixture and
    # cleanup use the same synchronous completion rule as selected test methods.
    original_module_cleanup = unittest.addModuleCleanup
    original_class_cleanup = unittest.TestCase.addClassCleanup.__func__

    def add_module_cleanup(function, /, *args, **kwargs):
        original_module_cleanup(call_synchronous, function, *args, **kwargs)

    @classmethod
    def add_class_cleanup(cls, function, /, *args, **kwargs):
        original_class_cleanup(cls, call_synchronous, function, *args, **kwargs)

    unittest.addModuleCleanup = unittest.case.addModuleCleanup = add_module_cleanup
    unittest.TestCase.addClassCleanup = add_class_cleanup

    def guard_class_hook(cls, name):
        if getattr(cls, name, None) is None:
            return
        hook = inspect.getattr_static(cls, name)
        if isinstance(hook, classmethod):
            def guarded(owner, original=hook.__func__):
                return call_synchronous(original, owner)
            setattr(cls, name, classmethod(guarded))
        else:
            function = hook.__func__ if isinstance(hook, staticmethod) else hook
            setattr(cls, name, staticmethod(partial(call_synchronous, function)))

    diagnostics = BoundedDiagnostics()
    with contextlib.redirect_stdout(diagnostics), contextlib.redirect_stderr(diagnostics):
        module_name = cfg["module"]
        spec = importlib.util.spec_from_file_location(module_name, cfg["script"])
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        for name in ("setUpModule", "tearDownModule"):
            hook = getattr(module, name, None)
            if hook is not None:
                setattr(module, name, partial(call_synchronous, hook))
        suite = unittest.TestSuite()
        wrapped_classes = set()
        for identifier in cfg["tests"]:
            if not identifier.startswith(module_name + "."):
                raise RuntimeError("test does not belong to the frozen module")
            parts = identifier[len(module_name) + 1:].split(".")
            owner = module
            for part in parts[:-1]:
                owner = getattr(owner, part)
            if not isinstance(owner, type) or not issubclass(owner, unittest.TestCase):
                raise RuntimeError("only explicit TestCase methods are supported")
            if not parts[-1].startswith("test_"):
                raise RuntimeError("only explicit test_* methods are supported")
            case = owner(parts[-1])
            for name in ("run", "_callTestMethod", "_callSetUp", "_callTearDown", "_callCleanup",
                         "doCleanups", "addClassCleanup", "doClassCleanups"):
                actual, standard = getattr(owner, name), getattr(unittest.TestCase, name)
                if getattr(actual, "__func__", actual) is not getattr(standard, "__func__", standard):
                    raise RuntimeError("custom TestCase execution dispatch is unsupported")
            if owner not in wrapped_classes:
                for name in ("setUpClass", "tearDownClass"):
                    guard_class_hook(owner, name)
                wrapped_classes.add(owner)
            for name in (parts[-1], "setUp", "tearDown", "setUpClass", "tearDownClass"):
                require_synchronous(getattr(case, name))
            # unittest otherwise only warns about unawaited/returned values and can
            # emit addSuccess without executing the selected test's body.
            case._callTestMethod = call_synchronous
            case._callSetUp = partial(call_synchronous, case.setUp)
            case._callTearDown = partial(call_synchronous, case.tearDown)
            case._callCleanup = call_synchronous
            if case.id() != identifier:
                raise RuntimeError("test identity changed")
            identities[id(case)] = identifier
            suite.addTest(case)
        result = Result()
        suite.run(result)
        for test, detail in result.errors + result.failures + result.expectedFailures:
            remaining = max(0, 16384 - diagnostics.tell())
            diagnostics.write((str(test) + ": " + detail + "\n")[:remaining])
    if diagnostics.getvalue():
        sys.stderr.write(diagnostics.getvalue())
    values = list(statuses.values())
    report = {"protocol": "check-result-v1", "tests": result.testsRun,
              "passed": values.count("passed"), "failed": values.count("failed"),
              "skipped": values.count("skipped"), "requiredCases": statuses,
              "skippedIds": [key for key, value in statuses.items() if value == "skipped"]}
    print(json.dumps(report, sort_keys=True))
    if not result.wasSuccessful() or len(statuses) != len(cfg["tests"]) or report["failed"]:
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Exception, SystemExit) as failure:
        if isinstance(failure, SystemExit):
            raise
        sys.stderr.write("Finite checker failed before a complete result: "
                         + type(failure).__name__ + "\n")
        sys.exit(2)
