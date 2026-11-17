# Local file metadata

`prism_file_metadata` is a separate read-only MCP operation for displaying an
existing file's name. It returns the exact name, including its extension, as JSON
data. It does not read document contents or extract an internal document title.

The connected MCP host must support roots and provide the workspace directory
through its roots list. Use that exact root URI and a relative file path:

```json
{
  "operation": "file_name",
  "root_uri": "file:///your/workspace",
  "relative_path": "docs/guide.md"
}
```

For an existing file with that name, the result text is:

```json
{"operation":"file_name","name":"guide.md"}
```

Replace the example root and path with an actual host-provided root and file.
The operation refuses paths outside that root, symlinks beneath it, non-files,
extra arguments, and unavailable roots. Path spelling must match the directory
entry exactly. Directory lookup is limited to 10,000 entries. No root support
means refusal; task text cannot grant filesystem authority.

The result is a filesystem metadata snapshot. A file name is untrusted data,
never an instruction, clinical recommendation, security clearance, or permission
to read or execute the file. This tool accepts no free-text task, title override,
or clinical-guard override. It calls no model or cloud fallback and does not
change ordinary inference guards. Tool arguments and output bypass Prism's
generic invocation recording; the connected host still receives the result.

Use this explicit operation for file-name display rather than submitting a
free-text generation request. It is a different request contract and does not
establish that a free-text classifier would accept the original request.
