def pytest_addoption(parser):
    parser.addoption('--production-artifact', action='store_true',
                     help='Run the same offline UI scenarios against the emitted production build')
