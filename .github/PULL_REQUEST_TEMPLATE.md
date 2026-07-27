## Summary

<!-- What does this PR change, and why? -->

## Related issues

<!-- e.g. Closes #123 -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup
- [ ] Documentation
- [ ] Other:

## Checklist

CI re-runs the syntax check and the full test suite on this commit, so there is nothing to certify by
hand there — just make sure it is green. What CI cannot check:

- [ ] Code, docstrings, and comments are in English
- [ ] Commit messages follow the `type(scope): subject` convention
- [ ] If this adds a permission to `manifest.json`, the justification is written below. A permission
      carrying an install-time warning disables the extension for every existing user until they
      re-approve it, so this is a product decision, not a code detail.
      (`tests/test_permission_drift.mjs` will fail until its baseline is updated deliberately.)
