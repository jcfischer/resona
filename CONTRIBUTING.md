# Contributing to Resona

Thank you for your interest in contributing to Resona! This document provides guidelines and information for contributors.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/resona.git`
3. Install dependencies: `bun install`
4. Create a branch: `git checkout -b feature/your-feature-name`

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) v1.0 or later
- [Ollama](https://ollama.ai) (for running embedding tests with real models)
- SQLite with extension support:
  - **macOS**: `brew install sqlite`
  - **Linux**: Usually available by default

### Running Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test test/service/embedding-service.test.ts

# Run tests in watch mode
bun test --watch
```

## Code Style

- **TypeScript**: All code must be written in TypeScript
- **Formatting**: Use the project's existing formatting conventions
- **Types**: Prefer explicit types over `any`
- **Documentation**: Add JSDoc comments to public APIs

## Test-Driven Development (TDD)

We follow TDD practices. When adding new features:

1. **Write tests first** - Create failing tests that describe the expected behavior
2. **Implement minimally** - Write just enough code to make tests pass
3. **Refactor** - Clean up while keeping tests green

Example workflow:

```bash
# 1. Write test in test/service/new-feature.test.ts
# 2. Run test - should fail
bun test test/service/new-feature.test.ts

# 3. Implement in src/service/new-feature.ts
# 4. Run test - should pass
bun test test/service/new-feature.test.ts

# 5. Run full test suite to check for regressions
bun test
```

## Pull Request Process

1. **Ensure all tests pass**: Run `bun test` before submitting
2. **Update documentation**: Update README.md if adding new features
3. **Write clear commit messages**: Follow conventional commits format
   - `feat:` for new features
   - `fix:` for bug fixes
   - `docs:` for documentation changes
   - `test:` for test additions/changes
   - `refactor:` for code refactoring
4. **Keep PRs focused**: One feature or fix per PR
5. **Describe your changes**: Explain what and why in the PR description

## Commit Message Format

```
type: short description

Longer description if needed, explaining:
- What changed
- Why it changed
- Any breaking changes
```

Examples:
```
feat: add OpenAI embedding provider

- Implement OpenAIProvider class
- Support text-embedding-3-small and text-embedding-3-large models
- Add API key configuration
```

```
fix: handle empty batch in embedBatch

The embedBatch method now returns early with zero counts
when given an empty array, avoiding unnecessary API calls.
```

## Adding New Providers

To add a new embedding provider:

1. Create `src/providers/your-provider.ts` implementing `EmbeddingProvider`
2. Add tests in `test/providers/your-provider.test.ts`
3. Export from `src/index.ts`
4. Add model dimensions to `src/types.ts` constants
5. Update README.md with usage examples

## Reporting Issues

When reporting bugs, please include:

- Resona version
- Bun version
- Operating system
- Steps to reproduce
- Expected vs actual behavior
- Error messages (if any)

## Feature Requests

Feature requests are welcome! Please:

- Check existing issues first
- Describe the use case
- Explain why it would benefit other users

## Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Help others learn and grow

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

## Questions?

Feel free to open an issue for any questions about contributing.
