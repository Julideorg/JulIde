# The notebook kernel julIDE drives over stdin. Loaded by notebook_session.rs via
# include_str! and passed with `julia -e`.
#
# Everything lives in `module JulIDENB` for two reasons, both of which broke a top-level
# version of this: a top-level `while` loop is a *hard* scope, so the loop's own counters
# are not visible inside it; and every name here would otherwise sit in `Main` next to
# the user's, so a cell doing `send = 1` or `counter = 99` would break the kernel. User
# code is still evaluated into `Main` — only the driver is hidden.
#
# ## Why the streams are rearranged
#
# Protocol messages and user output must never interleave, and `println` from a cell is
# the least of it: `ccall(:write, ..., 1, ...)`, a `run(`echo`)` subprocess, GR and
# PyCall all write file descriptor 1 directly. So fd 1 is *duplicated* first — giving a
# private handle nothing else knows about — and only then redirected. Everything the
# user's code emits, at any level, lands in a pipe that a task forwards as framed
# `stream` messages. The real fd 1 carries protocol JSON and nothing else.
#
# stdin gets the same treatment in reverse: a cell calling `readline()` would otherwise
# consume the next cell's code off the command channel and wedge the kernel for good.

module JulIDENB

using Base64
using REPL

# ── Private channels, captured before anything is redirected ──────────────────
# `Int(::RawFD)` and `rawfd.fd` both fail on 1.12; `Base.cconvert` is the portable path.
const _pfd = Base.Libc.dup(RawFD(1))
const PROTO = fdio(Base.cconvert(Cint, _pfd), true)
const _ifd = Base.Libc.dup(RawFD(0))
const CMDIN = fdio(Base.cconvert(Cint, _ifd), true)

const MAX_BUNDLE_BYTES = 8 * 1024 * 1024
const BUNDLE_MIMES = [
    "image/png",
    "image/jpeg",
    "image/svg+xml",
    "text/html",
    "text/latex",
    "text/markdown",
    "application/json",
]
const BINARY_MIMES = Set(["image/png", "image/jpeg"])

const _current_exec = Ref{String}("")
const _exec_count = Ref{Int}(0)

# ── Minimal JSON encoding ─────────────────────────────────────────────────────
# Hand-rolled because Julia has no JSON stdlib, and requiring a package would make the
# kernel fail to start in any environment that has not installed one.

function _esc(io::IO, s::AbstractString)
    print(io, '"')
    for c in s
        if c == '"'
            print(io, "\\\"")
        elseif c == '\\'
            print(io, "\\\\")
        elseif c == '\n'
            print(io, "\\n")
        elseif c == '\r'
            print(io, "\\r")
        elseif c == '\t'
            print(io, "\\t")
        elseif c < ' '
            print(io, "\\u", lpad(string(UInt16(c), base = 16), 4, '0'))
        else
            print(io, c)
        end
    end
    print(io, '"')
end

_json(io::IO, s::AbstractString) = _esc(io, s)
_json(io::IO, n::Integer) = print(io, n)
_json(io::IO, b::Bool) = print(io, b ? "true" : "false")
_json(io::IO, ::Nothing) = print(io, "null")

function _json(io::IO, v::AbstractVector)
    print(io, '[')
    for (i, x) in enumerate(v)
        i > 1 && print(io, ',')
        _json(io, x)
    end
    print(io, ']')
end

function _json(io::IO, d::AbstractDict)
    print(io, '{')
    first = true
    for (k, v) in d
        first || print(io, ',')
        first = false
        _esc(io, string(k))
        print(io, ':')
        _json(io, v)
    end
    print(io, '}')
end

"""Emit one protocol message. The only thing that ever writes to the real fd 1."""
function send(d::AbstractDict)
    _json(PROTO, d)
    print(PROTO, '\n')
    flush(PROTO)
    return nothing
end

# ── Stream capture ────────────────────────────────────────────────────────────
# A sentinel written into both pipes after a cell finishes, and waited on before the
# reply is sent. Without it the pump is just another task and a slow flush would let a
# cell's last lines arrive after the reply — i.e. attributed to the *next* cell.

const _sync_token = Ref{String}("")
const _sync_seen = Channel{String}(32)

function _pump(rd::IO, name::String)
    @async begin
        try
            while !eof(rd)
                line = readline(rd; keep = true)
                if startswith(line, "\0JSYNC:")
                    put!(_sync_seen, name)
                    continue
                end
                # Captured bytes can be invalid UTF-8 (a subprocess writing latin-1,
                # a truncated multi-byte sequence at a chunk boundary). Scrub before
                # the encoder sees it rather than throwing inside the pump.
                text = isvalid(line) ? line : String(collect(Char, line))
                send(Dict("kind" => "stream", "exec_id" => _current_exec[],
                          "name" => name, "text" => text))
            end
        catch
            # The pipe closing during shutdown is normal.
        end
    end
end

function _barrier()
    token = string("\0JSYNC:", rand(UInt64), "\0")
    _sync_token[] = token
    println(stdout, token)
    flush(stdout)
    println(stderr, token)
    flush(stderr)
    seen = 0
    while seen < 2
        try
            take!(_sync_seen)
            seen += 1
        catch
            break
        end
    end
end

# ── MIME bundles ──────────────────────────────────────────────────────────────

function bundle(x)
    data = Dict{String,String}()
    for mime in BUNDLE_MIMES
        try
            showable(MIME(mime), x) || continue
            io = IOBuffer()
            show(io, MIME(mime), x)
            bytes = take!(io)
            length(bytes) > MAX_BUNDLE_BYTES && continue
            data[mime] = mime in BINARY_MIMES ? base64encode(bytes) : String(bytes)
        catch
            # A broken `show` method for one mime must not lose the others.
        end
    end
    # text/plain always, and always limited: an unlimited show of a 10^6-element array
    # serialises megabytes nobody asked for.
    try
        io = IOBuffer()
        show(IOContext(io, :limit => true, :color => false), MIME("text/plain"), x)
        data["text/plain"] = String(take!(io))
    catch e
        data["text/plain"] = string("<show failed: ", sprint(showerror, e), ">")
    end
    return data
end

"""A display that routes `display(x)` inside a cell to its own protocol message."""
struct NBDisplay <: AbstractDisplay end

function Base.display(::NBDisplay, x)
    send(Dict("kind" => "display", "exec_id" => _current_exec[],
              "data" => Base.invokelatest(bundle, x)))
    return nothing
end

# ── Execution ─────────────────────────────────────────────────────────────────

function _traceback(e, bt)
    # InterruptException's raw backtrace is twenty frames of scheduler internals.
    if e isa InterruptException
        return ["Interrupted by the user."]
    end
    text = sprint(Base.showerror, e, bt)
    return split(text, '\n')
end

function run_cell(exec_id::String, code::String, path::String, lineno::Int)
    _current_exec[] = exec_id
    send(Dict("kind" => "status", "exec_id" => exec_id, "state" => "busy"))

    status = "ok"
    try
        # `parseall` with a real filename and line number so stack frames point at the
        # user's own file — `include_string` cannot do that, and clickable error
        # locations are most of the value of a traceback.
        ast = Meta.parseall(code; filename = path, lineno = lineno)
        # Soft scope is not optional: without it the first `for` loop anyone writes over
        # a global throws UndefVarError. 1-arg only — the 2-arg method is gone as of 1.12.
        value = Base.invokelatest(Core.eval, Main, REPL.softscope(ast))
        _exec_count[] += 1
        if value !== nothing && !REPL.ends_with_semicolon(strip(code))
            send(Dict("kind" => "result", "exec_id" => exec_id,
                      "execution_count" => _exec_count[],
                      "data" => Base.invokelatest(bundle, value)))
        end
    catch e
        status = e isa InterruptException ? "abort" : "error"
        bt = catch_backtrace()
        send(Dict("kind" => "error", "exec_id" => exec_id,
                  "ename" => string(typeof(e).name.name),
                  "evalue" => sprint(Base.showerror, e),
                  "traceback" => _traceback(e, bt)))
    end

    _barrier()
    send(Dict("kind" => "reply", "exec_id" => exec_id, "status" => status,
              "execution_count" => _exec_count[]))
    _current_exec[] = ""
    return nothing
end

# ── The loop ──────────────────────────────────────────────────────────────────

function serve()
    # Required for interrupts: without it SIGINT terminates the process instead of
    # throwing InterruptException into the running cell.
    Base.exit_on_sigint(false)

    out_rd, out_wr = redirect_stdout()
    err_rd, err_wr = redirect_stderr()
    _pump(out_rd, "stdout")
    _pump(err_rd, "stderr")
    # A cell calling readline() would otherwise eat the next EXEC header.
    redirect_stdin(devnull)

    pushdisplay(NBDisplay())
    ENV["GKSwstype"] = "100"

    send(Dict("kind" => "ready", "version" => string(VERSION), "pid" => getpid()))

    while true
        local header
        try
            eof(CMDIN) && break
            header = readline(CMDIN)
        catch e
            # A SIGINT landing while idle — after the reply, before the next command —
            # must not take the kernel down with it.
            e isa InterruptException && continue
            break
        end
        isempty(header) && continue

        parts = split(header, ' ')
        if parts[1] == "SHUTDOWN"
            break
        elseif parts[1] == "EXEC" && length(parts) == 5
            exec_id = String(parts[2])
            nbytes = parse(Int, parts[3])
            lineno = parse(Int, parts[4])
            path = String(base64decode(parts[5]))
            # Length-prefixed rather than delimited, so code containing any sentinel we
            # might have chosen is still read exactly.
            code = String(read(CMDIN, nbytes))
            read(CMDIN, 1) # the newline terminating the payload
            try
                run_cell(exec_id, code, path, lineno)
            catch e
                e isa InterruptException || rethrow()
            end
        end
    end

    flush(out_wr)
    flush(err_wr)
    return nothing
end

end # module

JulIDENB.serve()
