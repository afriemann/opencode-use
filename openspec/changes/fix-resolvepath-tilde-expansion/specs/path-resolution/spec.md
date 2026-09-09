## ADDED Requirements

### Requirement: Tilde Expansion

The path-resolution helper SHALL expand a leading `~` (the entire input) or
`~/...` (a `~` followed by a path separator) to the current user's home
directory before applying absolute-path passthrough or relative-path
resolution. Expansion SHALL use the current user's home directory only;
`~otheruser/...` (tilde followed by a different username) SHALL NOT be
expanded and is instead treated as a literal path segment.

#### Scenario: Input path is a bare tilde

- GIVEN a `path` argument equal to `~`
- WHEN the tool resolves the path
- THEN the resolved path equals the current user's home directory

#### Scenario: Input path starts with tilde-slash

- GIVEN a `path` argument of the form `~/relative/subpath`
- WHEN the tool resolves the path
- THEN the resolved path equals the current user's home directory joined with `relative/subpath`

#### Scenario: Input path references another user's home directory

- GIVEN a `path` argument of the form `~otheruser/subpath`
- WHEN the tool resolves the path
- THEN the tilde is left unexpanded and `~otheruser/subpath` is resolved as a literal relative path against the base directory, per the existing relative-path resolution rules
