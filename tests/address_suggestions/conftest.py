def pytest_addoption(parser):
    parser.addoption('--address-artifact', action='store_true',
                     help='Run address scenarios against a local emitted frontend with fictional config')
