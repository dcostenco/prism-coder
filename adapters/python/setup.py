"""
Prism Memory Python Package

Provides framework adapters for LangChain, CrewAI, AutoGen, and LlamaIndex.
"""

from setuptools import setup, find_packages

setup(
    name="prism-memory",
    version="0.1.0",
    description="Python memory adapters for Prism MCP — LangChain, CrewAI, AutoGen, LlamaIndex",
    long_description=open("README.md").read() if __import__("os").path.exists("README.md") else "",
    long_description_content_type="text/markdown",
    author="Synalux",
    author_email="dev@synalux.com",
    url="https://github.com/synalux/prism",
    packages=find_packages(),
    python_requires=">=3.9",
    install_requires=[],  # Zero required deps — adapters import frameworks lazily
    extras_require={
        "langchain": ["langchain>=0.1.0"],
        "crewai": ["crewai>=0.1.0"],
        "autogen": ["pyautogen>=0.2.0"],
        "llamaindex": ["llama-index>=0.10.0"],
        "all": ["langchain>=0.1.0", "crewai>=0.1.0", "pyautogen>=0.2.0", "llama-index>=0.10.0"],
    },
    classifiers=[
        "Development Status :: 3 - Alpha",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Topic :: Software Development :: Libraries :: Python Modules",
    ],
)
